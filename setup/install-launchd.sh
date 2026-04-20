#!/bin/bash
# Install the Ollama delayed-start launchd agent.
# Run this once after cloning the repo.
#
# Usage:  bash setup/install-launchd.sh

set -euo pipefail

PLIST_NAME="com.obsidian-vault-mcp.ollama.plist"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/$PLIST_NAME"
TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

# Ensure LaunchAgents dir exists and is writable
if [ ! -w "$HOME/Library/LaunchAgents" ]; then
  echo "⚠️  ~/Library/LaunchAgents is not writable. Fixing ownership..."
  sudo chown "$USER:staff" "$HOME/Library/LaunchAgents"
fi

# Unload if already loaded
launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true

# Copy plist
cp "$SOURCE" "$TARGET"
echo "✅ Copied $PLIST_NAME → ~/Library/LaunchAgents/"

# Load
launchctl bootstrap "gui/$(id -u)" "$TARGET"
echo "✅ Loaded. Ollama will auto-start 5 minutes after login."
echo ""
echo "   To verify:  launchctl print gui/$(id -u)/$PLIST_NAME"
echo "   To remove:  launchctl bootout gui/$(id -u)/$PLIST_NAME && rm $TARGET"
echo "   Logs:       /tmp/ollama-launchd.{out,err}.log"
