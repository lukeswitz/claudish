#!/bin/bash
# claudish installer
# Usage: curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudish/main/install.sh | bash
#
# Security: This script downloads and executes a binary. Review before running.
# Safer alternative: Download manually and verify checksums
#   https://github.com/MadAppGang/claudish/releases

set -e
set -u  # Exit on undefined variables
set -o pipefail  # Catch errors in pipes

REPO="MadAppGang/claudish"
INSTALL_DIR="${CLAUDISH_INSTALL_DIR:-$HOME/.local/bin}"

# Cleanup temporary files on exit
cleanup() {
    [ -n "${TMP_FILE:-}" ] && [ -f "$TMP_FILE" ] && rm -f "$TMP_FILE"
}
trap cleanup EXIT INT TERM

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[success]${NC} $1"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $1"; }
error()   { echo -e "${RED}[error]${NC} $1"; exit 1; }

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux";;
        Darwin*) os="darwin";;
        MINGW*|MSYS*|CYGWIN*) error "Windows detected. Use: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex";;
        *) error "Unsupported OS: $(uname -s)";;
    esac

    case "$(uname -m)" in
        x86_64|amd64)  arch="x64";;
        arm64|aarch64) arch="arm64";;
        *) error "Unsupported architecture: $(uname -m)";;
    esac

    echo "${os}-${arch}"
}

get_latest_version() {
    local response
    response=$(curl -fsSL --tlsv1.2 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null)

    # Verify we got valid JSON
    if ! echo "$response" | grep -q '"tag_name"'; then
        error "Failed to fetch release info from GitHub API"
    fi

    echo "$response" | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/'
}

compute_sha256() {
    if command -v sha256sum &>/dev/null; then
        sha256sum "$1" | cut -d' ' -f1
    elif command -v shasum &>/dev/null; then
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

verify_checksum() {
    local file="$1" version="$2" platform="$3"
    local checksums_url="https://github.com/${REPO}/releases/download/v${version}/checksums.txt"
    local expected actual

    expected=$(curl -fsSL --tlsv1.2 "$checksums_url" 2>/dev/null | grep "claudish-${platform}" | cut -d' ' -f1)

    if [ -z "$expected" ]; then
        warn "Checksums not available, skipping verification"
        return 0
    fi

    actual=$(compute_sha256 "$file")

    if [ -z "$actual" ]; then
        warn "No sha256 tool found, skipping verification"
        return 0
    fi

    if [ "$expected" != "$actual" ]; then
        error "Checksum mismatch!\n  Expected: ${expected}\n  Got:      ${actual}"
    fi

    success "Checksum verified"
}

install() {
    local platform version download_url

    platform=$(detect_platform)
    info "Platform: ${CYAN}${platform}${NC}"

    version=$(get_latest_version)
    [ -z "$version" ] && error "Could not determine latest version"
    info "Version: ${CYAN}v${version}${NC}"

    download_url="https://github.com/${REPO}/releases/download/v${version}/claudish-${platform}"
    info "Downloading: ${download_url}"

    # Create secure temporary file
    TMP_FILE=$(mktemp -t claudish.XXXXXXXXXX) || error "Failed to create temporary file"

    # Download with TLS 1.2+ and fail on HTTP errors
    if ! curl -fsSL --tlsv1.2 "$download_url" -o "$TMP_FILE"; then
        error "Download failed. Check network connection and version availability."
    fi

    verify_checksum "$TMP_FILE" "$version" "$platform"

    # Install with secure permissions
    mkdir -p "$INSTALL_DIR"
    chmod 755 "$TMP_FILE"
    mv "$TMP_FILE" "${INSTALL_DIR}/claudish"

    success "Installed to ${INSTALL_DIR}/claudish"

    if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
        warn "${INSTALL_DIR} is not in PATH"
        echo ""
        echo "Add to your shell config:"
        echo "  export PATH=\"\$PATH:${INSTALL_DIR}\""
    fi
}

main() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║${NC}  ${GREEN}claudish${NC} installer                   ${CYAN}║${NC}"
    echo -e "${CYAN}║${NC}  Run Claude Code with any model        ${CYAN}║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
    echo ""

    # Security notice for piped installs
    if [ -t 0 ]; then
        # Running interactively, safe to prompt
        :
    else
        # Piped from curl, show warning
        warn "Running installer from pipe. Review source before installing:"
        echo "  ${CYAN}https://github.com/${REPO}/blob/main/install.sh${NC}"
        echo ""
    fi

    command -v curl &>/dev/null || error "curl is required"

    install

    echo ""
    success "Installation complete!"
    echo ""
    echo "Quick start:"
    echo "  ${CYAN}claudish${NC}                  # Interactive mode"
    echo "  ${CYAN}claudish --model <name>${NC}   # Use specific model"
    echo "  ${CYAN}claudish --help${NC}           # Show all options"
    echo ""
    echo "MCP server (Claude Code integration):"
    echo "  ${CYAN}claudish --mcp${NC}"
    echo ""
    echo -e "${YELLOW}Security Notice:${NC}"
    echo "  Set up secure credential storage:"
    echo "    ${CYAN}mkdir -p ~/.config/claudish${NC}"
    echo "    ${CYAN}echo 'OPENROUTER_API_KEY=sk-or-v1-...' > ~/.config/claudish/credentials${NC}"
    echo "    ${CYAN}chmod 600 ~/.config/claudish/credentials${NC}"
    echo ""
    echo "  Load credentials in your shell profile (~/.bashrc or ~/.zshrc):"
    echo "    ${CYAN}export \$(grep -v '^#' ~/.config/claudish/credentials | xargs)${NC}"
    echo ""
    echo "  Learn more: ${CYAN}https://github.com/${REPO}#security${NC}"
    echo ""
}

main "$@"
