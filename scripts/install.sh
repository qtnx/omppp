#!/bin/sh
set -e

# OMP Coding Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.sh | sh
#
# Options:
#   --source       Install via bun (requires bun to already be installed)
#   --binary       Always install prebuilt binary
#   --ref <ref>    Install specific tag/commit/branch
#   -r <ref>       Shorthand for --ref

REPO="can1357/oh-my-pi"
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

has_supported_bun() {
    version_raw=$(bun --version 2>/dev/null || true)
    if [ -z "$version_raw" ]; then
        return 1
    fi

    version_clean=${version_raw%%-*}
    version_ge "$version_clean" "$MIN_BUN_VERSION"
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

# Install via bun
install_via_bun() {
    echo "Installing via bun..."
    if [ -n "$REF" ]; then
        if ! has_git; then
            echo "git is required for --ref when installing from source"
            exit 1
        fi

        TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/omp-install.XXXXXX")"
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
    echo ""
    echo "✓ Installed omp via bun"
    echo "Run 'omp' to get started!"
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

    BINARY="omp-${PLATFORM}-${ARCH}"
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
    TMP_BINARY="$(mktemp "${INSTALL_DIR}/.omp.XXXXXX")"
    TMP_CHECKSUMS="$(mktemp "${INSTALL_DIR}/.omp-checksums.XXXXXX")"
    trap 'rm -f "$TMP_BINARY" "$TMP_CHECKSUMS"' EXIT

    # Download binary, verify its release checksum, then install atomically.
    BINARY_URL="${RELEASE_DOWNLOAD_BASE_URL}/${LATEST}/${BINARY}"
    echo "Downloading ${BINARY}..."
    curl -fsSL "$BINARY_URL" -o "$TMP_BINARY"
    verify_release_checksum "$BINARY" "$TMP_BINARY" "$LATEST" "$TMP_CHECKSUMS"
    mv "$TMP_BINARY" "${INSTALL_DIR}/omp"
    chmod +x "${INSTALL_DIR}/omp"
    echo ""
    echo "✓ Installed omp to ${INSTALL_DIR}/omp"

    # Check if in PATH
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) echo "Run 'omp' to get started!" ;;
        *) echo "Add ${INSTALL_DIR} to your PATH, then run 'omp'" ;;
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
        # Default: use bun if available, otherwise binary
        if has_bun && has_supported_bun; then
            install_via_bun
        else
            install_binary
        fi
        ;;
esac
