#!/bin/sh
set -e

# OMPx Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/qtnx/omppp/main/scripts/install.sh | sh
#
# By default this downloads the prebuilt binary from the GitHub releases of
# qtnx/omppp. The npm registry is never used unless you opt in with --source.
#
# Options:
#   --source       Install via bun from source (requires bun to already be installed)
#   --binary       Always install prebuilt binary (default)
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="qtnx/omppp"
PACKAGE="@oh-my-pi/pi-coding-agent"
INSTALL_DIR="${PI_INSTALL_DIR:-$HOME/.local/bin}"
MIN_BUN_VERSION="1.3.14"
API_BASE_URL="${PI_GITHUB_API_BASE_URL:-https://api.github.com/repos/${REPO}}"
RELEASE_DOWNLOAD_BASE_URL="${PI_RELEASE_DOWNLOAD_BASE_URL:-https://github.com/${REPO}/releases/download}"

# Parse arguments
MODE=""
REF=""
while [ $# -gt 0 ]; do
    case "$1" in
        --source)
            MODE="source"
            shift
            ;;
        --binary)
            MODE="binary"
            shift
            ;;
        --ref)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        --ref=*)
            REF="${1#*=}"
            if [ -z "$REF" ]; then
                echo "Missing value for --ref"
                exit 1
            fi
            shift
            ;;
        -r)
            shift
            if [ -z "$1" ]; then
                echo "Missing value for -r"
                exit 1
            fi
            REF="$1"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# If a ref is provided, default to source install
if [ -n "$REF" ] && [ -z "$MODE" ]; then
    MODE="source"
fi

# Check if bun is available
has_bun() {
    command -v bun >/dev/null 2>&1
}

version_ge() {
    current="$1"
    minimum="$2"

    current_major="${current%%.*}"
    current_rest="${current#*.}"
    current_minor="${current_rest%%.*}"
    current_patch="${current_rest#*.}"
    current_patch="${current_patch%%.*}"

    minimum_major="${minimum%%.*}"
    minimum_rest="${minimum#*.}"
    minimum_minor="${minimum_rest%%.*}"
    minimum_patch="${minimum_rest#*.}"
    minimum_patch="${minimum_patch%%.*}"

    if [ "$current_major" -ne "$minimum_major" ]; then
        [ "$current_major" -gt "$minimum_major" ]
        return $?
    fi

    if [ "$current_minor" -ne "$minimum_minor" ]; then
        [ "$current_minor" -gt "$minimum_minor" ]
        return $?
    fi

    [ "$current_patch" -ge "$minimum_patch" ]
}

require_bun_version() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        echo "Failed to read bun version"
        exit 1
    fi

    version_clean=${version_raw%%-*}
    if ! version_ge "$version_clean" "$MIN_BUN_VERSION"; then
        echo "Bun ${MIN_BUN_VERSION} or newer is required. Current version: ${version_clean}"
        echo "Upgrade Bun at https://bun.sh/docs/installation"
        exit 1
    fi
}

# Check if git is available
has_git() {
    command -v git >/dev/null 2>&1
}

# Source installs require Bun, but this installer deliberately does not fetch
# and execute a remote Bun bootstrap script. Install Bun through your OS package
# manager or the official instructions first, then rerun with --source.
install_bun() {
    echo "Bun ${MIN_BUN_VERSION} or newer is required for source installs."
    echo "Install Bun from https://bun.sh/docs/installation, then rerun this installer."
    exit 1
}

# Check if git-lfs is available
has_git_lfs() {
    command -v git-lfs >/dev/null 2>&1
}

sha256_file() {
    file="$1"

    if command -v sha256sum >/dev/null 2>&1; then
        set -- $(sha256sum "$file")
        printf '%s\n' "$1"
        return
    fi

    if command -v shasum >/dev/null 2>&1; then
        set -- $(shasum -a 256 "$file")
        printf '%s\n' "$1"
        return
    fi

    if command -v openssl >/dev/null 2>&1; then
        set -- $(openssl dgst -sha256 -r "$file")
        printf '%s\n' "$1"
        return
    fi

    echo "No SHA-256 tool found; install sha256sum, shasum, or openssl." >&2
    exit 1
}

verify_release_checksum() {
    binary_name="$1"
    binary_path="$2"
    release_tag="$3"
    checksums_path="$4"
    checksums_url="${RELEASE_DOWNLOAD_BASE_URL}/${release_tag}/SHA256SUMS"

    echo "Verifying ${binary_name} checksum..."
    if ! curl -fsSL "$checksums_url" -o "$checksums_path"; then
        echo "Failed to download SHA256SUMS for ${release_tag}; refusing to install an unverifiable binary." >&2
        echo "Retry later, or use --source after installing Bun ${MIN_BUN_VERSION} or newer." >&2
        exit 1
    fi

    expected=""
    while IFS= read -r line; do
        checksum="${line%%  *}"
        name="${line#"$checksum"  }"
        if [ "$name" = "$line" ]; then
            continue
        fi
        name="${name#\*}"
        case "$checksum" in
            ""|*[!0123456789abcdefABCDEF]*)
                continue
                ;;
        esac
        if [ "${#checksum}" -ne 64 ]; then
            continue
        fi
        case "$name" in
            ""|.|..|*/*|*\\*)
                continue
                ;;
        esac
        if [ "$name" = "$binary_name" ]; then
            expected="$checksum"
            break
        fi
    done < "$checksums_path"

    if [ -z "$expected" ]; then
        echo "SHA256SUMS does not contain ${binary_name}" >&2
        exit 1
    fi

    actual="$(sha256_file "$binary_path")"
    if [ "$actual" != "$expected" ]; then
        echo "Checksum verification failed for ${binary_name}" >&2
        echo "Expected: ${expected}" >&2
        echo "Actual:   ${actual}" >&2
        exit 1
    fi
}

install_standard_config() {
    if [ "${OMPX_INSTALL_SKIP_STANDARD_CONFIG:-}" = "1" ]; then
        return
    fi

    config_dir="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
    config_file="${config_dir}/config.yml"
    if [ -e "$config_file" ]; then
        echo "✓ Existing config kept at ${config_file}"
        return
    fi

    mkdir -p "$config_dir"
    cat > "$config_file" <<'EOF_CONFIG'
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
EOF_CONFIG
    chmod 600 "$config_file" 2>/dev/null || true
    echo "✓ Seeded OMPx standard config at ${config_file}"
}

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ompx-install.XXXXXX")"
        trap 'rm -rf "$TMP_DIR"' EXIT

        if git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP_DIR" >/dev/null 2>&1; then
            :
        else
            git clone "https://github.com/${REPO}.git" "$TMP_DIR"
            (cd "$TMP_DIR" && git checkout "$REF")
        fi

        # Pull LFS files
        if has_git_lfs; then
            (cd "$TMP_DIR" && git lfs pull)
        fi

        if [ ! -d "$TMP_DIR/packages/coding-agent" ]; then
            echo "Expected package at ${TMP_DIR}/packages/coding-agent"
            exit 1
        fi

        bun install -g "$TMP_DIR/packages/coding-agent" || {
            echo "Failed to install from source"
            exit 1
        }
    else
        bun install -g "$PACKAGE" || {
            echo "Failed to install $PACKAGE"
            exit 1
        }
    fi
    install_standard_config
    echo ""
    echo "✓ Installed OMPx via bun"
    echo "Run 'ompx' to get started!"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    BINARY="ompx-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL "${API_BASE_URL}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Failed to fetch release metadata for: $REF"
            echo "If this is a branch or commit, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        if RELEASE_JSON=$(curl -fsSL "${API_BASE_URL}/releases/latest"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Failed to fetch latest release metadata."
            exit 1
        fi
    fi

    if [ -z "$LATEST" ]; then
        echo "Failed to fetch release tag"
        exit 1
    fi
    echo "Using version: $LATEST"

    mkdir -p "$INSTALL_DIR"
    TMP_BINARY="$(mktemp "${INSTALL_DIR}/.ompx.XXXXXX")"
    TMP_CHECKSUMS="$(mktemp "${INSTALL_DIR}/.ompx-checksums.XXXXXX")"
    trap 'rm -f "$TMP_BINARY" "$TMP_CHECKSUMS"' EXIT

    # Download binary, verify its release checksum, then install atomically.
    BINARY_URL="${RELEASE_DOWNLOAD_BASE_URL}/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    # Show a progress bar on an interactive terminal; stay quiet when stderr is
    # not a TTY (piped installs, CI) so logs aren't flooded with bar redraws.
    if [ -t 2 ]; then
        curl -fSL --progress-bar "$BINARY_URL" -o "$TMP_BINARY"
    else
        curl -fsSL "$BINARY_URL" -o "$TMP_BINARY"
    fi
    verify_release_checksum "$BINARY" "$TMP_BINARY" "$LATEST" "$TMP_CHECKSUMS"
    mv "$TMP_BINARY" "${INSTALL_DIR}/ompx"
    chmod +x "${INSTALL_DIR}/ompx"
    install_standard_config
    echo ""
    echo "✓ Installed OMPx to ${INSTALL_DIR}/ompx"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'ompx' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'ompx'" ;;
    esac
}

# Main logic
case "$MODE" in
    source)
        if ! has_bun; then
            install_bun
        fi
        require_bun_version
        install_via_bun
        ;;
    binary)
        install_binary
        ;;
    *)
        # Default: always install the prebuilt binary from GitHub releases.
        # The npm registry is never used here; pass --source to install via bun.
        install_binary
        ;;
esac
