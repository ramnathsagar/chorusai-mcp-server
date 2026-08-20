// read-key.mjs — reads CHORUS_API_KEY from the Claude Desktop config for local testing only.
// Never logs, prints, or writes the key anywhere else.
//
// Looks for any mcpServers entry with a CHORUS_API_KEY (rather than hardcoding the server's
// config key name), so this keeps working no matter what you name the entry in your own
// claude_desktop_config.json (e.g. "chorusai-mcp-server", "chorus-icp", etc).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

export function readChorusApiKeyFromDesktopConfig() {
  const path = `${homedir()}/Library/Application Support/Claude/claude_desktop_config.json`;
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  for (const server of Object.values(cfg.mcpServers || {})) {
    const key = server?.env?.CHORUS_API_KEY;
    if (key) return key;
  }
  throw new Error("No mcpServers entry with a CHORUS_API_KEY found in the Claude Desktop config.");
}
