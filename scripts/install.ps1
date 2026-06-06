# OMPx Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.ps1))) -Source -Ref v3.20.1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.ps1))) -Binary -Ref v3.20.1

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "qtnx/omppp"
$Package = "@oh-my-pi/pi-coding-agent"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\ompx" }
$BinaryName = "ompx-windows-x64.exe"
$MinimumBunVersion = "1.3.14"
$ApiBaseUrl = if ($env:PI_GITHUB_API_BASE_URL) { $env:PI_GITHUB_API_BASE_URL.TrimEnd([char]"/") } else { "https://api.github.com/repos/$Repo" }
$ReleaseDownloadBaseUrl = if ($env:PI_RELEASE_DOWNLOAD_BASE_URL) { $env:PI_RELEASE_DOWNLOAD_BASE_URL.TrimEnd([char]"/") } else { "https://github.com/$Repo/releases/download" }

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Get-AgentConfigDir {
    if ($env:PI_CODING_AGENT_DIR) {
        return $env:PI_CODING_AGENT_DIR
    }
    return (Join-Path $env:USERPROFILE ".omp\agent")
}

function ConvertTo-YamlSingleQuoted {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Set-ConfigShellPath {
    param(
        [string]$ConfigFile,
        [string]$ShellPath
    )

    $line = "shellPath: $(ConvertTo-YamlSingleQuoted $ShellPath)"
    if (Test-Path $ConfigFile) {
        $content = Get-Content $ConfigFile -Raw
        $lines = $content -split '\r?\n', -1
        $updated = $false
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match "^shellPath:\s*") {
                $lines[$i] = $line
                $updated = $true
            }
        }

        if ($updated) {
            $content = [string]::Join("`n", $lines)
        } else {
            if ($content.Length -gt 0 -and -not $content.EndsWith("`n")) {
                $content += "`n"
            }
            $content += "$line`n"
        }
    } else {
        $content = "$line`n"
    }

    Set-Content -Path $ConfigFile -Value $content -Encoding UTF8
}

function Configure-BashShell {
    if ($env:OMPX_INSTALL_SKIP_BASH_CONFIG -eq "1") {
        return
    }

    try {
        $configDir = Get-AgentConfigDir
        $configFile = Join-Path $configDir "config.yml"

        if (Test-Path $configFile) {
            try {
                $existingConfig = Get-Content $configFile -Raw
                if ($existingConfig -match "(?m)^shellPath:\s*(.+)$") {
                    Write-Host "Bash shell already configured: $($Matches[1])" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Unreadable config: continue and let the write path surface the error.
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            if (-not (Test-Path $configDir)) {
                New-Item -ItemType Directory -Force -Path $configDir | Out-Null
            }

            Set-ConfigShellPath -ConfigFile $configFile -ShellPath $bashPath
            Write-Host "✓ Configured shell path in $configFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "⚠ No bash shell found!" -ForegroundColor Yellow
            Write-Host "  OMPx requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $configFile" -ForegroundColor Yellow
            Write-Host "    shellPath: 'C:\path\to\bash.exe'" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠ Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-StandardConfig {
    if ($env:OMPX_INSTALL_SKIP_STANDARD_CONFIG -eq "1") {
        return
    }

    $ConfigDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $env:USERPROFILE ".omp\agent" }
    $ConfigFile = Join-Path $ConfigDir "config.yml"
    if (Test-Path $ConfigFile) {
        Write-Host "✓ Existing config kept at $ConfigFile" -ForegroundColor Green
        return
    }

    New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
    @'
# OMPx standard agent config.
# Safe backup of ~/.omp/agent/config.yml for bootstrapping new machines.
# Copy to ~/.omp/agent/config.yml before first run, or let the installer seed it
# when the target config file does not already exist.
modelRoles:
  default: openai-codex/gpt-5.5:xhigh
  task: anthropic/claude-opus-4-8
  smol: anthropic/claude-sonnet-4-6
  slow: openai-codex/gpt-5.5:high
  plan: anthropic/claude-opus-4-8:xhigh
  designer: anthropic/claude-opus-4-8
  commit: openai-codex/gpt-5.5:low
task:
  showResolvedModelBadge: true
  agentModelOverrides:
    agent-creator: anthropic/
    code-architect: pi/plan
    code-explorer: pi/smol
    code-reviewer: openai-codex/codex-auto-review
    code-simplifier: anthropic/claude-opus-4-8
    codex-rescue: openai-codex/gpt-5.5:medium
    designer: anthropic/claude-opus-4-8:xhigh
    oracle: openai-codex/gpt-5.5:xhigh
    plan: openai-codex/gpt-5.5:xhigh
    quick_task: openai-codex/gpt-5.5:low
    reviewer: openai-codex/gpt-5.5:xhigh
    task: openai-codex/gpt-5.5:medium
workflow:
  enabled: true
dev:
  autoqa:
    consent: denied
memory:
  backend: hindsight
learning:
  enabled: true
  classifierModels:
    - openai-codex/gpt-5.4-mini
    - openai-codex/gpt-5.3-codex-spark
    - anthropic/claude-haiku-4-5
    - pi/smol
    - pi/default
hindsight:
  apiUrl: http://localhost:8888
hideThinkingBlock: false
providers:
  webSearch: perplexity
symbolPreset: unicode
theme:
  dark: titanium
setupVersion: 1
retry:
  fallbackChains:
    task:
      - anthropic/claude-opus-4-8
      - openai-codex/gpt-5.5:low
    smol:
      - openai-codex/gpt-5.3-codex-spark
      - anthropic/claude-haiku-4-5
'@ | Set-Content -Path $ConfigFile -Encoding UTF8
    Write-Host "✓ Seeded OMPx standard config at $ConfigFile" -ForegroundColor Green
}

function Install-Bun {
    throw "Bun $MinimumBunVersion or newer is required for source installs. Install Bun from https://bun.sh/docs/installation, then rerun this installer."
}

function Install-ViaBun {
    Write-Host "Installing via bun..."
    if ($Ref) {
        if (-not (Test-GitInstalled)) {
            throw "git is required for -Ref when installing from source"
        }

        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ompx-install-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

        try {
            $repoUrl = "https://github.com/$Repo.git"
            $cloneOk = $false
            try {
                git clone --depth 1 --branch $Ref $repoUrl $tmpRoot | Out-Null
                $cloneOk = $true
            } catch {
                $cloneOk = $false
            }

            if (-not $cloneOk) {
                git clone $repoUrl $tmpRoot | Out-Null
                Push-Location $tmpRoot
                try {
                    git checkout $Ref | Out-Null
                } finally {
                    Pop-Location
                }
            }

            # Pull LFS files
            if (Test-GitLfsInstalled) {
                Push-Location $tmpRoot
                try {
                    git lfs pull | Out-Null
                } finally {
                    Pop-Location
                }
            }

            $packagePath = Join-Path $tmpRoot "packages\coding-agent"
            if (-not (Test-Path $packagePath)) {
                throw "Expected package at $packagePath"
            }

            bun install -g $packagePath
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install from $packagePath via bun"
            }
        } finally {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    } else {
        bun install -g $Package
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install $Package via bun"
        }
    }

    Install-StandardConfig
    Write-Host ""
    Write-Host "✓ Installed OMPx via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'ompx' to get started!"
}

function Get-ExpectedChecksum {
    param(
        [string]$ChecksumsPath,
        [string]$ExpectedFileName
    )

    foreach ($line in Get-Content $ChecksumsPath) {
        $trimmed = $line.Trim()
        if (-not $trimmed) {
            continue
        }

        $parts = $trimmed -split '\s+'
        if ($parts.Length -ne 2) {
            continue
        }

        $checksum = $parts[0].ToLowerInvariant()
        $fileName = $parts[1].TrimStart([char]"*")
        if ($checksum -notmatch '^[0-9a-f]{64}$') {
            continue
        }
        if ($fileName -match '[\\/]' -or $fileName -eq "." -or $fileName -eq "..") {
            continue
        }
        if ($fileName -ceq $ExpectedFileName) {
            return $checksum
        }
    }

    throw "SHA256SUMS does not contain $ExpectedFileName"
}

function Assert-BinaryChecksum {
    param(
        [string]$BinaryPath,
        [string]$ExpectedFileName,
        [string]$ReleaseTag,
        [string]$ChecksumsPath
    )

    $ChecksumsUrl = "$ReleaseDownloadBaseUrl/$ReleaseTag/SHA256SUMS"
    Write-Host "Verifying $ExpectedFileName checksum..."
    try {
        Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $ChecksumsPath
    } catch {
        throw "Failed to download SHA256SUMS for $ReleaseTag. Refusing to install an unverifiable binary. To use -Source instead, install Bun $MinimumBunVersion or newer first. Original error: $($_.Exception.Message)"
    }

    $expected = Get-ExpectedChecksum -ChecksumsPath $ChecksumsPath -ExpectedFileName $ExpectedFileName
    $actual = (Get-FileHash -Algorithm SHA256 $BinaryPath).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        throw "Checksum verification failed for $ExpectedFileName. Expected: $expected Actual: $actual"
    }
}

function Normalize-PathEntry {
    param([string]$PathValue)

    if (-not $PathValue) {
        return ""
    }

    try {
        return [System.IO.Path]::GetFullPath($PathValue).TrimEnd([char[]]@([char]0x5c, [char]0x2f))
    } catch {
        return $PathValue.TrimEnd([char[]]@([char]0x5c, [char]0x2f))
    }
}

function Install-Binary {
    if ($Ref) {
        Write-Host "Fetching release $Ref..."
        try {
            $Release = Invoke-RestMethod -Uri "$ApiBaseUrl/releases/tags/$Ref"
        } catch {
            throw "Failed to fetch release metadata for $Ref. If this is a branch or commit, use -Source with -Ref. Original error: $($_.Exception.Message)"
        }
    } else {
        Write-Host "Fetching latest release..."
        try {
            $Release = Invoke-RestMethod -Uri "$ApiBaseUrl/releases/latest"
        } catch {
            throw "Failed to fetch latest release metadata. Original error: $($_.Exception.Message)"
        }
    }

    $Latest = $Release.tag_name
    if (-not $Latest) {
        throw "Failed to fetch release tag"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary, verify its release checksum, then install atomically.
    $BinaryUrl = "$ReleaseDownloadBaseUrl/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "ompx.exe"
    $TempBinary = Join-Path $InstallDir (".ompx-download-" + [System.Guid]::NewGuid().ToString("N") + ".exe")
    $TempChecksums = Join-Path $InstallDir (".ompx-checksums-" + [System.Guid]::NewGuid().ToString("N"))
    try {
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $TempBinary
        Assert-BinaryChecksum -BinaryPath $TempBinary -ExpectedFileName $BinaryName -ReleaseTag $Latest -ChecksumsPath $TempChecksums
        Move-Item -Path $TempBinary -Destination $OutPath -Force
    } finally {
        Remove-Item -Force $TempBinary -ErrorAction SilentlyContinue
        Remove-Item -Force $TempChecksums -ErrorAction SilentlyContinue
    }

    Install-StandardConfig
    Write-Host ""
    Write-Host "✓ Installed OMPx to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $normalizedInstallDir = Normalize-PathEntry $InstallDir
    $pathEntries = if ($UserPath) { $UserPath -split ';' } else { @() }
    $needsRestart = -not ($pathEntries | Where-Object { (Normalize-PathEntry $_) -ieq $normalizedInstallDir })
    $skipPathUpdate = $env:OMPX_INSTALL_SKIP_PATH_UPDATE -eq "1"
    if ($needsRestart -and -not $skipPathUpdate) {
        Write-Host "Adding $InstallDir to PATH..."
        $newPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    } elseif ($needsRestart) {
        Write-Host "Skipping persistent PATH update because OMPX_INSTALL_SKIP_PATH_UPDATE=1."
    }

    Configure-BashShell

    if ($needsRestart -and -not $skipPathUpdate) {
        Write-Host "Restart your terminal, then run 'ompx' to get started!"
    } elseif ($needsRestart) {
        Write-Host "Add $InstallDir to PATH, then run 'ompx'."
    } else {
        Write-Host "Run 'ompx' to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: use bun if available and current enough, otherwise binary
    if ((Test-BunInstalled) -and (Test-BunVersion $MinimumBunVersion)) {
        Install-ViaBun
    } else {
        Install-Binary
    }
}
