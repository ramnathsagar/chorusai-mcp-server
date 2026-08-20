#!/usr/bin/env bash
# setup.sh — install deps for chorusai-mcp-server and print your Claude Desktop config block.
# Your API key is NOT handled here; it goes into the printed config only.
set -euo pipefail
cd "$(dirname "$0")"

command -v node >/dev/null || { echo "Node.js 18+ is required (https://nodejs.org). Aborting."; exit 1; }
echo "==> Node: $(node --version)"
echo "==> Installing dependency (@modelcontextprotocol/sdk)..."
npm install --no-audit --no-fund >/dev/null 2>&1
echo "==> Done."

NODE_BIN="$(command -v node)"
ENTRY="$(pwd)/index.js"

cat <<EOF

============================================================
 Add this to Claude Desktop > Settings > Developer > Edit Config
 Replace YOUR_API_KEY with your Chorus token, then Cmd+Q and reopen.
============================================================

{
  "mcpServers": {
    "chorusai-mcp-server": {
      "command": "$NODE_BIN",
      "args": ["$ENTRY"],
      "env": {
        "CHORUS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}

Then in a chat: "Use chorus_health to check the connection", or
"Use get_account_brief for Acme Robotics and acme.example."
EOF
