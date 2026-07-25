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

# Normalized host architecture (x64|arm64). On macOS this uses
# `sysctl hw.optional.arm64` so it stays correct inside a Rosetta session,
# where `uname -m` reports the translated x86_64.
host_arch() {
    if [ "$(uname -s)" = "Darwin" ]; then
        if [ "$(sysctl -in hw.optional.arm64 2>/dev/null || /usr/sbin/sysctl -in hw.optional.arm64 2>/dev/null)" = "1" ]; then
            echo "arm64"
        else
            echo "x64"
        fi
        return
    fi
    case "$(uname -m)" in
        x86_64|amd64)  echo "x64" ;;
        arm64|aarch64) echo "arm64" ;;
        *)             uname -m ;;
    esac
}

# Bun's own architecture (x64|arm64), or empty when it can't be determined.
bun_arch() {
    bun -e 'process.stdout.write(process.arch)' 2>/dev/null
}

# True when Bun's architecture matches the host. If Bun's arch can't be read,
# assume a match rather than block the install.
bun_arch_matches_host() {
    ba="$(bun_arch)"
    [ -z "$ba" ] && return 0
    [ "$ba" = "$(host_arch)" ]
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
    if ! curl -fsSL --connect-timeout 10 --max-time 60 "$checksums_url" -o "$checksums_path"; then
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

migrate_syntax_highlighting_config() {
    config_file="$1"

    if [ ! -f "$config_file" ]; then
        return
    fi

    if grep -Eq '^[[:space:]]*syntaxHighlighting[[:space:]]*:' "$config_file"; then
        return
    fi

    if grep -Eq '^display:[[:space:]]*($|#)' "$config_file"; then
        tmp_config="$(mktemp "${config_file}.XXXXXX")"
        awk '
            BEGIN {
                inserted = 0
                in_display = 0
            }
            {
                if (in_display == 1 && inserted == 0 && $0 !~ /^([[:space:]]|$|#)/) {
                    print "  syntaxHighlighting: basic"
                    inserted = 1
                    in_display = 0
                }
                print
                if (inserted == 0 && in_display == 0 && $0 ~ /^display:[[:space:]]*($|#)/) {
                    in_display = 1
                }
            }
            END {
                if (in_display == 1 && inserted == 0) {
                    print "  syntaxHighlighting: basic"
                }
            }
        ' "$config_file" > "$tmp_config"
        mv "$tmp_config" "$config_file"
    else
        printf '\ndisplay:\n  syntaxHighlighting: basic\n' >> "$config_file"
    fi

    chmod 600 "$config_file" 2>/dev/null || true
    echo "✓ Migrated config syntax highlighting to basic at ${config_file}"
}

migrate_ui_agent_overrides_config() {
    config_file="$1"

    if [ ! -f "$config_file" ]; then
        return
    fi

    tmp_config="$(mktemp "${config_file}.XXXXXX")"
    awk '
        function trim(value) {
            gsub(/^[[:space:]]+/, "", value)
            gsub(/[[:space:]]+$/, "", value)
            return value
        }
        function remember_ui_key(key) {
            if (key == "designer") {
                have_designer = 1
            } else if (key == "frontend_ui") {
                have_frontend_ui = 1
            } else if (key == "ui_ux_reviewer") {
                have_ui_ux_reviewer = 1
            } else if (key == "ux_copywriter") {
                have_ux_copywriter = 1
            }
        }
        function normalized_ui_value(key, value) {
            if (value == "pi/designer") {
                return "tnx/designer"
            }
            if (key == "designer" && value == "anthropic/claude-opus-4-8:xhigh") {
                return "tnx/designer"
            }
            return value
        }
        function insert_missing_ui_overrides() {
            if (!have_designer) {
                print override_indent "designer: tnx/designer"
            }
            if (!have_frontend_ui) {
                print override_indent "frontend_ui: tnx/designer"
            }
            if (!have_ui_ux_reviewer) {
                print override_indent "ui_ux_reviewer: tnx/designer"
            }
            if (!have_ux_copywriter) {
                print override_indent "ux_copywriter: tnx/designer"
            }
        }
        function child_indent(indent_len) {
            return sprintf("%*s", indent_len + 2, "")
        }
        function append_ui_overrides_block(child) {
            print child "agentModelOverrides:"
            print child "  designer: tnx/designer"
            print child "  frontend_ui: tnx/designer"
            print child "  ui_ux_reviewer: tnx/designer"
            print child "  ux_copywriter: tnx/designer"
        }
        function emit_inline_override(entry, key, value, colon) {
            entry = trim(entry)
            if (entry == "") {
                return
            }
            colon = index(entry, ":")
            if (colon == 0) {
                return
            }
            key = trim(substr(entry, 1, colon - 1))
            value = trim(substr(entry, colon + 1))
            value = normalized_ui_value(key, value)
            remember_ui_key(key)
            print override_indent key ": " value
        }
        function emit_inline_overrides(line, body, count, i) {
            match(line, /^[[:space:]]*/)
            parent_indent_len = RLENGTH
            override_indent = substr(line, RSTART, RLENGTH) "  "
            body = line
            sub(/^[^{]*\{[[:space:]]*/, "", body)
            sub(/[[:space:]]*\}[[:space:]]*(#.*)?$/, "", body)
            print substr(line, RSTART, RLENGTH) "agentModelOverrides:"
            count = split(body, inline_entries, ",")
            for (i = 1; i <= count; i++) {
                emit_inline_override(inline_entries[i])
            }
            insert_missing_ui_overrides()
        }
        BEGIN {
            in_overrides = 0
            found_overrides = 0
            in_task = 0
            inserted_overrides = 0
            override_indent = ""
            have_designer = 0
            have_frontend_ui = 0
            have_ui_ux_reviewer = 0
            have_ux_copywriter = 0
            parent_indent_len = 0
            task_indent_len = 0
        }
        {
            if (in_overrides == 0 && $0 ~ /^[[:space:]]*agentModelOverrides:[[:space:]]*\{.*\}[[:space:]]*(#.*)?$/) {
                found_overrides = 1
                inserted_overrides = 1
                in_task = 0
                emit_inline_overrides($0)
                next
            }

            if (in_overrides == 0 && $0 ~ /^[[:space:]]*agentModelOverrides:[[:space:]]*($|#)/) {
                found_overrides = 1
                inserted_overrides = 1
                in_task = 0
                in_overrides = 1
                match($0, /^[[:space:]]*/)
                parent_indent_len = RLENGTH
                override_indent = substr($0, RSTART, RLENGTH) "  "
                print
                next
            }

            if (in_overrides == 1) {
                if ($0 ~ /^[[:space:]]*$/) {
                    print
                    next
                }
                if ($0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }

                match($0, /^[[:space:]]*/)
                current_indent_len = RLENGTH
                if (current_indent_len <= parent_indent_len) {
                    insert_missing_ui_overrides()
                    in_overrides = 0
                    print
                    next
                }

                if ($0 ~ /^[[:space:]]*designer:[[:space:]]*/) {
                    have_designer = 1
                    if ($0 ~ /^[[:space:]]*designer:[[:space:]]*pi\/designer[[:space:]]*(#.*)?$/) {
                        sub(/pi\/designer/, "tnx/designer")
                    } else if ($0 ~ /^[[:space:]]*designer:[[:space:]]*anthropic\/claude-opus-4-8:xhigh[[:space:]]*(#.*)?$/) {
                        sub(/anthropic\/claude-opus-4-8:xhigh/, "tnx/designer")
                    }
                } else if ($0 ~ /^[[:space:]]*frontend_ui:[[:space:]]*/) {
                    have_frontend_ui = 1
                    if ($0 ~ /^[[:space:]]*frontend_ui:[[:space:]]*pi\/designer[[:space:]]*(#.*)?$/) {
                        sub(/pi\/designer/, "tnx/designer")
                    }
                } else if ($0 ~ /^[[:space:]]*ui_ux_reviewer:[[:space:]]*/) {
                    have_ui_ux_reviewer = 1
                    if ($0 ~ /^[[:space:]]*ui_ux_reviewer:[[:space:]]*pi\/designer[[:space:]]*(#.*)?$/) {
                        sub(/pi\/designer/, "tnx/designer")
                    }
                } else if ($0 ~ /^[[:space:]]*ux_copywriter:[[:space:]]*/) {
                    have_ux_copywriter = 1
                    if ($0 ~ /^[[:space:]]*ux_copywriter:[[:space:]]*pi\/designer[[:space:]]*(#.*)?$/) {
                        sub(/pi\/designer/, "tnx/designer")
                    }
                }

                print
                next
            }

            if (found_overrides == 0 && inserted_overrides == 0 && in_task == 0 && $0 ~ /^[[:space:]]*task:[[:space:]]*($|#)/) {
                in_task = 1
                match($0, /^[[:space:]]*/)
                task_indent_len = RLENGTH
                print
                next
            }

            if (in_task == 1 && inserted_overrides == 0) {
                if ($0 ~ /^[[:space:]]*$/) {
                    print
                    next
                }
                if ($0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }

                match($0, /^[[:space:]]*/)
                current_indent_len = RLENGTH
                if (current_indent_len <= task_indent_len) {
                    append_ui_overrides_block(child_indent(task_indent_len))
                    inserted_overrides = 1
                    in_task = 0
                    print
                    next
                }

                print
                next
            }

            print
        }
        END {
            if (in_overrides == 1) {
                insert_missing_ui_overrides()
            }
            if (in_task == 1 && inserted_overrides == 0) {
                append_ui_overrides_block(child_indent(task_indent_len))
                inserted_overrides = 1
            }
            if (found_overrides == 0 && inserted_overrides == 0) {
                print ""
                print "task:"
                append_ui_overrides_block("  ")
            }
        }
    ' "$config_file" > "$tmp_config"
    mv "$tmp_config" "$config_file"
    chmod 600 "$config_file" 2>/dev/null || true
}

migrate_gpt_5_6_model_config() {
    config_file="$1"

    if [ ! -f "$config_file" ]; then
        return
    fi

    tmp_config="$(mktemp "${config_file}.XXXXXX")"
    awk '
        function indent_length(line) {
            match(line, /^[[:space:]]*/)
            return RLENGTH
        }
        function insert_missing_gpt_overrides() {
            if (!have_heavy_task) {
                print override_indent "heavy_task: openai-codex/gpt-5.6-terra:high"
            }
            if (!have_qa) {
                print override_indent "qa: openai-codex/gpt-5.6-sol:high"
            }
            if (!have_reviewer) {
                print override_indent "reviewer: openai-codex/codex-auto-review"
            }
            if (!have_tester) {
                print override_indent "tester: openai-codex/gpt-5.6-sol:medium"
            }
        }
        BEGIN {
            in_model_roles = 0
            in_task = 0
            in_overrides = 0
            model_roles_indent = 0
            task_indent = 0
            overrides_indent = 0
            override_indent = ""
            have_heavy_task = 0
            have_qa = 0
            have_reviewer = 0
            have_tester = 0
        }
        {
            if (in_model_roles) {
                if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }
                current_indent = indent_length($0)
                if (current_indent <= model_roles_indent) {
                    in_model_roles = 0
                } else {
                    if ($0 ~ /^[[:space:]]*default:[[:space:]]*openai-codex\/gpt-5\.5:xhigh[[:space:]]*(#.*)?$/ || $0 ~ /^[[:space:]]*plan:[[:space:]]*openai-codex\/gpt-5\.5:xhigh[[:space:]]*(#.*)?$/) {
                        sub(/openai-codex\/gpt-5\.5:xhigh/, "openai-codex/gpt-5.6-sol:xhigh")
                    } else if ($0 ~ /^[[:space:]]*task:[[:space:]]*openai-codex\/gpt-5\.5:medium[[:space:]]*(#.*)?$/) {
                        sub(/openai-codex\/gpt-5\.5:medium/, "openai-codex/gpt-5.6-terra:medium")
                    } else if ($0 ~ /^[[:space:]]*slow:[[:space:]]*openai-codex\/gpt-5\.5:high[[:space:]]*(#.*)?$/) {
                        sub(/openai-codex\/gpt-5\.5:high/, "openai-codex/gpt-5.6-sol:high")
                    } else if ($0 ~ /^[[:space:]]*commit:[[:space:]]*openai-codex\/gpt-5\.5:low[[:space:]]*(#.*)?$/) {
                        sub(/openai-codex\/gpt-5\.5:low/, "openai-codex/gpt-5.6-luna:high")
                    }
                    print
                    next
                }
            }

            if (in_overrides) {
                if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }
                current_indent = indent_length($0)
                if (current_indent <= overrides_indent) {
                    insert_missing_gpt_overrides()
                    in_overrides = 0
                } else {
                    if ($0 ~ /^[[:space:]]*heavy_task:[[:space:]]*/) {
                        have_heavy_task = 1
                        if ($0 ~ /openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/) {
                            sub(/openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/, "openai-codex/gpt-5.6-terra:high")
                        } else if ($0 ~ /openai-codex\/gpt-5\.6-sol:high/) {
                            sub(/openai-codex\/gpt-5\.6-sol:high/, "openai-codex/gpt-5.6-terra:high")
                        }
                    } else if ($0 ~ /^[[:space:]]*oracle:[[:space:]]*/ || $0 ~ /^[[:space:]]*qa:[[:space:]]*/) {
                        if ($0 ~ /^[[:space:]]*qa:[[:space:]]*/) {
                            have_qa = 1
                        }
                        if ($0 ~ /openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/) {
                            sub(/openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/, "openai-codex/gpt-5.6-sol:high")
                        }
                    } else if ($0 ~ /^[[:space:]]*reviewer:[[:space:]]*/) {
                        have_reviewer = 1
                        if ($0 ~ /openai-codex\/gpt-5\.(5|6-sol)(:[[:alnum:]_.-]+)?/) {
                            sub(/openai-codex\/gpt-5\.(5|6-sol)(:[[:alnum:]_.-]+)?/, "openai-codex/codex-auto-review")
                        }
                    } else if ($0 ~ /^[[:space:]]*quick_task:[[:space:]]*/) {
                        if ($0 ~ /openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/) {
                            sub(/openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/, "openai-codex/gpt-5.6-luna:high")
                        }
                    } else if ($0 ~ /^[[:space:]]*task:[[:space:]]*/) {
                        if ($0 ~ /openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/) {
                            sub(/openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/, "openai-codex/gpt-5.6-terra:medium")
                        }
                    } else if ($0 ~ /^[[:space:]]*tester:[[:space:]]*/) {
                        have_tester = 1
                        if ($0 ~ /openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/) {
                            sub(/openai-codex\/gpt-5\.5:[[:alnum:]_.-]+/, "openai-codex/gpt-5.6-sol:medium")
                        }
                    } else if ($0 ~ /^[[:space:]]*plan:[[:space:]]*openai-codex\/gpt-5\.5:xhigh[[:space:]]*(#.*)?$/) {
                        sub(/openai-codex\/gpt-5\.5:xhigh/, "anthropic/claude-fable-5:high")
                    }
                    print
                    next
                }
            }

            if (in_task) {
                if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }
                current_indent = indent_length($0)
                if (current_indent <= task_indent) {
                    in_task = 0
                } else if ($0 ~ /^[[:space:]]*agentModelOverrides:[[:space:]]*($|#)/) {
                    in_overrides = 1
                    overrides_indent = current_indent
                    override_indent = substr($0, 1, current_indent) "  "
                    print
                    next
                } else {
                    print
                    next
                }
            }

            if ($0 ~ /^modelRoles:[[:space:]]*($|#)/) {
                in_model_roles = 1
                model_roles_indent = 0
            } else if ($0 ~ /^task:[[:space:]]*($|#)/) {
                in_task = 1
                task_indent = 0
            }
            print
        }
        END {
            if (in_overrides) {
                insert_missing_gpt_overrides()
            }
        }
    ' "$config_file" > "$tmp_config"
    mv "$tmp_config" "$config_file"
    chmod 600 "$config_file" 2>/dev/null || true
    echo "✓ Migrated legacy GPT-5.5 config models to GPT-5.6 at ${config_file}"
}

migrate_heavy_task_fallback_chain() {
    config_file="$1"

    if [ ! -f "$config_file" ]; then
        return
    fi

    tmp_config="$(mktemp "${config_file}.XXXXXX")"
    awk '
        function indent_length(line) {
            match(line, /^[[:space:]]*/)
            return RLENGTH
        }
        function insert_heavy_task_fallback() {
            if (seen_child && !have_heavy_task) {
                print key_indent "heavy_task:"
                print key_indent "  - anthropic/claude-opus-5:high"
            }
        }
        BEGIN {
            in_retry = 0
            in_chains = 0
            retry_indent = 0
            chains_indent = 0
            key_indent = ""
            seen_child = 0
            have_heavy_task = 0
        }
        {
            if (in_chains) {
                if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }
                current_indent = indent_length($0)
                if (current_indent > chains_indent) {
                    seen_child = 1
                    if ($0 ~ /^[[:space:]]*heavy_task:[[:space:]]*($|#)/) {
                        have_heavy_task = 1
                    }
                    print
                    next
                }
                insert_heavy_task_fallback()
                in_chains = 0
                in_retry = 0
            }

            if (in_retry) {
                if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) {
                    print
                    next
                }
                current_indent = indent_length($0)
                if (current_indent <= retry_indent) {
                    in_retry = 0
                } else if ($0 ~ /^[[:space:]]*fallbackChains:[[:space:]]*($|#)/) {
                    in_chains = 1
                    chains_indent = current_indent
                    key_indent = substr($0, 1, current_indent) "  "
                    seen_child = 0
                    have_heavy_task = 0
                    print
                    next
                } else {
                    print
                    next
                }
            }

            if ($0 ~ /^retry:[[:space:]]*($|#)/) {
                in_retry = 1
                retry_indent = 0
            }
            print
        }
        END {
            if (in_chains) {
                insert_heavy_task_fallback()
            }
        }
    ' "$config_file" > "$tmp_config"
    mv "$tmp_config" "$config_file"
    chmod 600 "$config_file" 2>/dev/null || true
    echo "✓ Ensured heavy_task fallback chain at ${config_file}"
}

migrate_opus_model_config() {
    config_file="$1"

    if [ ! -f "$config_file" ]; then
        return
    fi

    if ! grep -q 'anthropic/claude-opus-4-8' "$config_file"; then
        return
    fi

    tmp_config="$(mktemp "${config_file}.XXXXXX")"
    awk '
        {
            # Retire the Opus 4.8 route wherever it is referenced - model roles,
            # agent overrides, fallback chains - keeping any :effort suffix intact.
            # Lines naming a claude-opus-4-8-<variant> id are left untouched.
            if ($0 !~ /anthropic\/claude-opus-4-8-/) {
                gsub(/anthropic\/claude-opus-4-8/, "anthropic/claude-opus-5")
            }
            print
        }
    ' "$config_file" > "$tmp_config"
    mv "$tmp_config" "$config_file"
    chmod 600 "$config_file" 2>/dev/null || true
    echo "✓ Migrated Claude Opus 4.8 config models to Opus 5 at ${config_file}"
}


run_config_update() {
    config_update_command="$1"

    if [ -z "$config_update_command" ]; then
        echo "Warning: OMPx config update command is unavailable; continuing install." >&2
        return 0
    fi

    case "$config_update_command" in
        */*)
            if [ ! -x "$config_update_command" ]; then
                echo "Warning: OMPx config update command is unavailable at ${config_update_command}; continuing install." >&2
                return 0
            fi
            config_update_path="$config_update_command"
            ;;
        *)
            if config_update_path="$(command -v "$config_update_command" 2>/dev/null)"; then
                :
            else
                echo "Warning: OMPx config update command is unavailable: ${config_update_command}; continuing install." >&2
                return 0
            fi
            ;;
    esac

    if "$config_update_path" config update --json >/dev/null 2>&1; then
        echo "✓ Updated OMPx config via ${config_update_path}"
    else
        echo "Warning: OMPx config update failed via ${config_update_path}; continuing install." >&2
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
        migrate_syntax_highlighting_config "$config_file"
        migrate_ui_agent_overrides_config "$config_file"
        return
    fi

    mkdir -p "$config_dir"
    cat > "$config_file" <<'EOF_CONFIG'
# OMPx standard agent config.
# Safe backup of ~/.omp/agent/config.yml for bootstrapping new machines.
# Copy to ~/.omp/agent/config.yml before first run, or let the installer seed it
# when the target config file does not already exist.
modelRoles:
  default: anthropic/claude-opus-5
  task: openai-codex/gpt-5.6-terra:medium
  smol: xai-oauth/grok-build
  slow: openai-codex/gpt-5.6-sol:high
  plan: openai-codex/gpt-5.6-sol:high
  designer: anthropic/claude-opus-5
  commit: xai-oauth/grok-build
task:
  showResolvedModelBadge: true
  agentModelOverrides:
    designer: tnx/designer
    explore: pi/smol
    frontend_ui: tnx/designer
    heavy_task: openai-codex/gpt-5.6-terra:high
    oracle: openai-codex/gpt-5.6-sol:high
    plan: anthropic/claude-fable-5:high
    qa: openai-codex/gpt-5.6-sol:high
    quick_task: openai-codex/gpt-5.6-luna:high
    reviewer: openai-codex/codex-auto-review
    task: openai-codex/gpt-5.6-terra:medium
    tester: openai-codex/gpt-5.6-sol:medium
    ui_ux_reviewer: tnx/designer
    ux_copywriter: tnx/designer
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
display:
  syntaxHighlighting: basic
setupVersion: 4
retry:
  fallbackChains:
    task:
      - anthropic/claude-opus-5
      - openai-codex/gpt-5.5:low
    smol:
      - openai-codex/gpt-5.3-codex-spark
      - anthropic/claude-haiku-4-5
    heavy_task:
      - anthropic/claude-opus-5:high
EOF_CONFIG
    chmod 600 "$config_file" 2>/dev/null || true
    echo "✓ Seeded OMPx standard config at ${config_file}"
}

install_superpowers_skill() {
    if [ "${OMPX_INSTALL_SKIP_SUPERPOWERS:-}" = "1" ]; then
        return
    fi

    ompx_cmd=""
    if [ -x "${INSTALL_DIR}/ompx" ]; then
        ompx_cmd="${INSTALL_DIR}/ompx"
    elif command -v ompx >/dev/null 2>&1; then
        ompx_cmd="$(command -v ompx)"
    fi

    if [ -z "$ompx_cmd" ]; then
        echo "Skipping Superpowers skill update; ompx was not found." >&2
        return
    fi

    echo "Updating Superpowers skills..."
    if "$ompx_cmd" install git:github.com/obra/superpowers; then
        echo "✓ Installed/updated Superpowers skills"
    else
        echo "Failed to update Superpowers skills; run 'ompx install git:github.com/obra/superpowers' manually." >&2
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
    run_config_update "ompx"
    migrate_gpt_5_6_model_config "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/config.yml"
    migrate_opus_model_config "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/config.yml"
    migrate_heavy_task_fallback_chain "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/config.yml"
    install_superpowers_skill
    echo ""
    echo "✓ Installed OMPx via bun"
    echo "Run 'ompx' to get started!"
}

# Install binary from GitHub releases
install_binary() {
    # Detect platform
    OS="$(uname -s)"
    ARCH="$(host_arch)"

    case "$OS" in
        Linux)  PLATFORM="linux" ;;
        Darwin) PLATFORM="darwin" ;;
        *)      echo "Unsupported OS: $OS"; exit 1 ;;
    esac

    case "$ARCH" in
        x64|arm64) ;;
        *)         echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac

    if [ "$PLATFORM" = "linux" ]; then
        if [ -f /etc/alpine-release ] || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
            PLATFORM="linux-musl"
        fi
    fi

    BINARY="ompx-${PLATFORM}-${ARCH}"
    # Get release tag
    if [ -n "$REF" ]; then
        echo "Fetching release $REF..."
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "${API_BASE_URL}/releases/tags/${REF}"); then
            LATEST=$(echo "$RELEASE_JSON" | grep '"tag_name"' | sed -E 's/.*"([^"]+)".*/\1/')
        else
            echo "Failed to fetch release metadata for: $REF"
            echo "If this is a branch or commit, use --source with --ref."
            exit 1
        fi
    else
        echo "Fetching latest release..."
        if RELEASE_JSON=$(curl -fsSL --connect-timeout 10 --max-time 60 "${API_BASE_URL}/releases/latest"); then
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
        curl -fSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 --progress-bar "$BINARY_URL" -o "$TMP_BINARY"
    else
        curl -fsSL --connect-timeout 10 --speed-limit 1024 --speed-time 30 "$BINARY_URL" -o "$TMP_BINARY"
    fi
    verify_release_checksum "$BINARY" "$TMP_BINARY" "$LATEST" "$TMP_CHECKSUMS"
    mv "$TMP_BINARY" "${INSTALL_DIR}/ompx"
    chmod +x "${INSTALL_DIR}/ompx"
    install_standard_config
    run_config_update "${INSTALL_DIR}/ompx"
    migrate_gpt_5_6_model_config "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/config.yml"
    migrate_opus_model_config "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/config.yml"
    migrate_heavy_task_fallback_chain "${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}/config.yml"
    install_superpowers_skill
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
        if ! bun_arch_matches_host; then
            echo "Error: bun reports architecture '$(bun_arch)' but this host is '$(host_arch)'."
            echo "Installing from source with this bun would produce a mismatched binary"
            echo "(e.g. x86_64 under Rosetta on Apple Silicon), causing slow startup and AVX warnings."
            echo "Install a native bun for your architecture, or re-run without --source to fetch the prebuilt $(host_arch) binary."
            exit 1
        fi
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
