#!/usr/bin/env node
// fetch-fixture.mjs — optional local diagnostics only. Pulls ONE live page of /v3/engagements
// (read-only) into an ignored file. The committed test suite uses synthetic fixtures instead.
// This output contains customer data: never stage, commit, upload, or share it.
//
//   node tests/fetch-fixture.mjs
//
// Note: CHORUS_API_KEY must be set on process.env BEFORE chorus-client.js is imported (it reads
// the env at module-load time), so this uses a dynamic import after setting it — a static
// top-level `import` would be hoisted above the assignment below and run too early.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readChorusApiKeyFromDesktopConfig } from "./read-key.mjs";

process.env.CHORUS_API_KEY ??= readChorusApiKeyFromDesktopConfig();
const { apiGet } = await import("../chorus-client.js");

const __dirname = dirname(fileURLToPath(import.meta.url));

const body = await apiGet("engagements");
const outPath = join(__dirname, "fixtures", "engagements-page1.json");
await writeFile(outPath, JSON.stringify(body, null, 2), "utf8");
console.log(`Saved ${body.engagements?.length ?? 0} engagements to ${outPath}`);
