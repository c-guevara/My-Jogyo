#!/bin/bash
#
# 🎓 Gyoshu & Jogyo Installer
# One-click installation for the research automation duo
#
set -e

# Colors for pretty output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}┌─────────────────────────────────────────────────────┐${NC}"
echo -e "${BLUE}│${NC}  🎓 ${GREEN}Gyoshu & Jogyo${NC} — Research Automation Installer  ${BLUE}│${NC}"
echo -e "${BLUE}│${NC}     ${YELLOW}교수 (Professor) + 조교 (Teaching Assistant)${NC}     ${BLUE}│${NC}"
echo -e "${BLUE}└─────────────────────────────────────────────────────┘${NC}"
echo ""

# Check if we're in a cloned repo or running via curl
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_URL="https://github.com/Yeachan-Heo/My-Jogyo.git"
TEMP_DIR=""

if [ -d "$SCRIPT_DIR/src" ]; then
    # Running from cloned repo
    SOURCE_DIR="$SCRIPT_DIR"
    echo -e "📂 Installing from local directory..."
else
    # Running via curl, need to clone
    echo -e "📥 Downloading Gyoshu & Jogyo..."
    TEMP_DIR=$(mktemp -d)
    git clone --depth 1 "$REPO_URL" "$TEMP_DIR" 2>/dev/null
    SOURCE_DIR="$TEMP_DIR"
fi

# 1. Create config directory
CONFIG_DIR="$HOME/.config/opencode"
echo -e "📁 Creating config directory: ${YELLOW}$CONFIG_DIR${NC}"
mkdir -p "$CONFIG_DIR"

# 2. Copy extension files
echo -e "📋 Copying extension files..."
if command -v rsync &> /dev/null; then
    rsync -a \
        --exclude='*.test.ts' \
        --exclude='*.test.js' \
        --exclude='node_modules' \
        --exclude='__pycache__' \
        --exclude='.git' \
        "$SOURCE_DIR/src/" "$CONFIG_DIR/"
else
    cp -r "$SOURCE_DIR/src/"* "$CONFIG_DIR/"
    find "$CONFIG_DIR" -name "*.test.ts" -delete 2>/dev/null || true
    find "$CONFIG_DIR" -name "*.test.js" -delete 2>/dev/null || true
fi

# 3. Clean up temp directory if used
if [ -n "$TEMP_DIR" ]; then
    rm -rf "$TEMP_DIR"
fi

# 4. Check Python
echo -e "🐍 Checking Python installation..."
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version 2>&1 | cut -d' ' -f2)
    echo -e "   Found Python ${GREEN}$PYTHON_VERSION${NC}"
else
    echo -e "${RED}❌ Python 3 not found. Please install Python 3.10+${NC}"
    exit 1
fi

# 5. Check OpenCode
echo -e "🔍 Checking OpenCode installation..."
if command -v opencode &> /dev/null; then
    echo -e "   ${GREEN}✓${NC} OpenCode found"
else
    echo -e "   ${YELLOW}⚠${NC} OpenCode not found in PATH"
    echo -e "   Install it from: ${BLUE}https://github.com/opencode-ai/opencode${NC}"
fi

# 6. Success!
echo ""
echo -e "${GREEN}┌─────────────────────────────────────────────────────┐${NC}"
echo -e "${GREEN}│${NC}  ✅ ${GREEN}Installation Complete!${NC}                          ${GREEN}│${NC}"
echo -e "${GREEN}└─────────────────────────────────────────────────────┘${NC}"
echo ""
echo -e "📍 ${YELLOW}Extension installed to:${NC} $CONFIG_DIR"
echo ""
echo -e "🚀 ${GREEN}Quick Start:${NC}"
echo ""
echo -e "   ${BLUE}opencode${NC}                          # Start OpenCode"
echo -e "   ${BLUE}/gyoshu${NC}                           # Meet the Professor"
echo -e "   ${BLUE}/gyoshu analyze my data${NC}           # Start research"
echo -e "   ${BLUE}/gyoshu-auto build ML model${NC}       # Autonomous mode"
echo ""
echo -e "📖 ${YELLOW}Documentation:${NC} https://github.com/Yeachan-Heo/My-Jogyo"
echo ""
echo -e "${BLUE}Happy researching! 🎓${NC}"
echo ""
