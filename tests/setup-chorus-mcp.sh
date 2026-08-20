#!/usr/bin/env bash
#
# setup-chorus-mcp.sh
# Builds a LOCAL, PATCHED copy of @opensourceops/chorus-mcp@0.1.1 whose API base
# URL is repointed from the dead /api/v1 surface to the live /v3 surface that
# your Chorus (ZoomInfo) token actually authenticates against.
#
# Your API key is NOT used or stored here. It goes only in the Claude Desktop
# config that this script prints at the end.
#
# Requires: Node.js 18+ and npm (same requirement the server already has).

set -euo pipefail

PKG="@opensourceops/chorus-mcp@0.1.1"
INSTALL_DIR="${1:-$HOME/chorus-mcp}"   # optional first arg overrides location

echo "==> Installing patched Chorus MCP server into: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo "==> Downloading pinned package tarball ($PKG)..."
npm pack "$PKG" >/dev/null
TARBALL="$(ls -t ./*chorus-mcp-*.tgz | head -1)"

echo "==> Extracting..."
rm -rf package
tar xzf "$TARBALL"
cd package

echo "==> Removing the inert self-dependency so npm install is clean..."
node -e "const p=require('./package.json'); if(p.dependencies){delete p.dependencies['@opensourceops/chorus-mcp'];} require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2));"

echo "==> Installing runtime dependencies (sdk, axios, express, zod)..."
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1

echo "==> Patching API base URL: /api/v1  ->  /v3 ..."
# macOS/BSD sed requires the empty '' after -i
sed -i '' 's#https://chorus.ai/api/v1#https://chorus.ai/v3#' dist/constants.js
echo -n "    now set to: "
grep -o 'https://[^"]*' dist/constants.js | head -1

NODE_BIN="$(command -v node)"
ENTRY="$(pwd)/dist/index.js"

echo ""
echo "============================================================"
echo " DONE. Add this block to your claude_desktop_config.json"
echo " (Claude Desktop > Settings > Developer > Edit Config)"
echo " Replace YOUR_API_KEY with your Chorus token, then fully"
echo " quit and reopen Claude Desktop (Cmd+Q)."
echo "============================================================"
cat <<EOF

{
  "mcpServers": {
    "chorus": {
      "command": "$NODE_BIN",
      "args": ["$ENTRY"],
      "env": {
        "CHORUS_API_KEY": "YOUR_API_KEY",
        "CHORUS_TOOL_MODE": "readonly"
      }
    }
  }
}

EOF
