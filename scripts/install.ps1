# OMP Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source -Ref v3.20.1
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary -Ref v3.20.1

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "can1357/oh-my-pi"
$Package = "@oh-my-pi/pi-coding-agent"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$BinaryName = "omp-windows-x64.exe"
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

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new. Avoid ConvertFrom-Json
            # -AsHashtable so the installer preserves settings on Windows
            # PowerShell 5.1, where that switch is unavailable.
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsedSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    foreach ($property in $parsedSettings.PSObject.Properties) {
                        $settings[$property.Name] = $property.Value
                    }
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "✓ Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "⚠ No bash shell found!" -ForegroundColor Yellow
            Write-Host "  OMP requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $settingsFile" -ForegroundColor Yellow
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "⚠ Could not configure bash shell: $_" -ForegroundColor Yellow
    }
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

        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-install-" + [System.Guid]::NewGuid().ToString("N"))
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

    Write-Host ""
    Write-Host "✓ Installed omp via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'omp' to get started!"
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
    $OutPath = Join-Path $InstallDir "omp.exe"
    $TempBinary = Join-Path $InstallDir (".omp-download-" + [System.Guid]::NewGuid().ToString("N") + ".exe")
    $TempChecksums = Join-Path $InstallDir (".omp-checksums-" + [System.Guid]::NewGuid().ToString("N"))
    try {
        Invoke-WebRequest -Uri $BinaryUrl -OutFile $TempBinary
        Assert-BinaryChecksum -BinaryPath $TempBinary -ExpectedFileName $BinaryName -ReleaseTag $Latest -ChecksumsPath $TempChecksums
        Move-Item -Path $TempBinary -Destination $OutPath -Force
    } finally {
        Remove-Item -Force $TempBinary -ErrorAction SilentlyContinue
        Remove-Item -Force $TempChecksums -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "✓ Installed omp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $normalizedInstallDir = Normalize-PathEntry $InstallDir
    $pathEntries = if ($UserPath) { $UserPath -split ';' } else { @() }
    $needsRestart = -not ($pathEntries | Where-Object { (Normalize-PathEntry $_) -ieq $normalizedInstallDir })
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        $newPath = if ($UserPath) { "$UserPath;$InstallDir" } else { $InstallDir }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
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
