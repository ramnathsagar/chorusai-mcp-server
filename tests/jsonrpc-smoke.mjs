#!/usr/bin/env node
// jsonrpc-smoke.mjs — live integration test. Spawns the REAL index.js as a subprocess (using the
// official MCP SDK Client + StdioClientTransport, so framing is guaranteed correct) and drives it
// over stdio: initialize -> tools/list -> tools/call for every tool, against the live Chorus API.
//
// CHORUS_API_KEY is read from the Claude Desktop config and passed ONLY into the child process's
// environment — never logged, printed, or written to disk by this script.
//
// Uses an isolated CHORUS_STORE_PATH (scratchpad, not the real per-user store) so this doesn't
// disturb anyone's actual cache, and so cold/warm/restart behavior is fully controlled.
//
//   node tests/jsonrpc-smoke.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readChorusApiKeyFromDesktopConfig } from "./read-key.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_JS = join(__dirname, "..", "index.js");
const SCRATCH_DIR = process.env.CHORUS_TEST_SCRATCH_DIR || "/private/tmp/claude-501/-Users-ramnath-chorus-mcp/88c4f948-adf5-4e32-8a2a-9db3392102c9/scratchpad";
const TEST_STORE_PATH = join(SCRATCH_DIR, `smoke-store-${process.pid}.json`);

const API_KEY = readChorusApiKeyFromDesktopConfig();

let passCount = 0, failCount = 0;
function check(label, cond, extra) {
  if (cond) { passCount++; console.log(`  ok - ${label}`); }
  else { failCount++; console.log(`  FAIL - ${label}${extra ? " :: " + JSON.stringify(extra) : ""}`); }
}

async function connect(envOverrides = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_JS],
    env: { CHORUS_API_KEY: API_KEY, CHORUS_STORE_PATH: TEST_STORE_PATH, ...envOverrides },
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} returned isError: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

console.log(`Test store: ${TEST_STORE_PATH}`);
if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH);

// ---- Process A: tools/list, chorus_health, diagnose_filters, backfill, warm ----
console.log("\n== Process A: initial connection (empty store) ==");
let { client: clientA, transport: transportA } = await connect();

const toolsList = await clientA.listTools();
const toolNames = toolsList.tools.map((t) => t.name).sort();
check("tools/list returns all 5 tools", JSON.stringify(toolNames) === JSON.stringify(["chorus_health", "diagnose_filters", "find_account_conversations", "get_account_brief", "get_engagement_detail"].sort()), toolNames);

console.log("\n-- chorus_health (empty store expected) --");
const health1 = await callTool(clientA, "chorus_health");
check("chorus_health.ok === true", health1.ok === true, health1);
check("chorus_health.store.record_count === 0 on first run", health1.store.record_count === 0, health1.store);
check("chorus_health.store.backfill_complete === false on first run", health1.store.backfill_complete === false, health1.store);
console.log(`  rate_limit headers: ${JSON.stringify(health1.rate_limit)}`);

console.log("\n-- diagnose_filters (live probe of documented params) --");
const diag = await callTool(clientA, "diagnose_filters");
for (const v of diag.variants) console.log(`  ${v.label}: ${v.appears_to_filter ?? "(baseline)"} (${v.results_on_page} results, http ${v.http_status})`);
check("diagnose_filters ran without HTTP errors on documented params", diag.variants.filter((v) => v.label.includes("documented")).every((v) => v.http_status < 400), diag.variants);

console.log("\n-- find_account_conversations: HISTORICAL BACKFILL (spread across bounded calls) --");
let lastResult = null;
let totalBackfillApiCalls = 0;
let iterations = 0;
const MAX_ITERATIONS = 15; // 150-page target / 40-page-per-call default ~= 4, generous safety margin
while (iterations < MAX_ITERATIONS) {
  iterations++;
  lastResult = await callTool(clientA, "find_account_conversations", { accounts: ["Atlassian"] });
  const s = lastResult.store;
  console.log(`  call ${iterations}: source=${s.source} pages=${s.pages_fetched_this_call} backfill_pages_done=${s.backfill_pages_done} backfill_complete=${s.backfill_complete} api_calls=${s.api_calls_this_call} capped=${s.capped}`);
  check(`backfill call ${iterations} triggers a sync while incomplete`, s.source.startsWith("synced"), s);
  check(`backfill call ${iterations} makes >0 API calls while incomplete`, s.api_calls_this_call > 0, s);
  totalBackfillApiCalls += s.api_calls_this_call;
  if (s.backfill_complete) break;
}
check("backfill_complete reached within a bounded number of calls", lastResult.store.backfill_complete === true, { iterations, lastStore: lastResult.store });
check("cold backfill finds Atlassian engagements", lastResult.accounts.some((a) => a.matched_as === "Atlassian" && a.engagements.length > 0), lastResult.accounts.map((a) => a.account));
console.log(`  backfill finished after ${iterations} call(s), ${totalBackfillApiCalls} total API calls, record_count=${lastResult.store.record_count}`);
const coldMatchCount = lastResult.accounts.reduce((n, a) => n + a.engagements.length, 0);

console.log("\n-- find_account_conversations: WARM (backfill done, expect zero API calls) --");
const warm = await callTool(clientA, "find_account_conversations", { accounts: ["Atlassian"] });
check("warm call reads from cache", warm.store.source === "cache", warm.store);
check("warm call makes exactly 0 API calls", warm.store.api_calls_this_call === 0, warm.store);
const warmMatchCount = warm.accounts.reduce((n, a) => n + a.engagements.length, 0);
check("warm results match backfilled results exactly", warmMatchCount === coldMatchCount, { warmMatchCount, coldMatchCount });

console.log("\n-- get_account_brief: full ICP bundle (cache) --");
const brief = await callTool(clientA, "get_account_brief", { accounts: ["Atlassian"] });
check("get_account_brief reuses cache (0 API calls)", brief.store.api_calls_this_call === 0, brief.store);
const withSummary = brief.accounts.flatMap((a) => a.engagements).filter((e) => e.meeting_summary);
check("get_account_brief returns real meeting_summary content", withSummary.length > 0 && typeof withSummary[0].meeting_summary === "string", withSummary[0]);
check("get_account_brief returns action_items arrays", Array.isArray(withSummary[0]?.action_items), withSummary[0]);

console.log("\n-- get_engagement_detail: ids already in store (expect 0 API calls) --");
const sampleIds = brief.accounts.flatMap((a) => a.engagements).slice(0, 2).map((e) => e.engagement_id);
const detail = await callTool(clientA, "get_engagement_detail", { engagement_ids: sampleIds });
check("get_engagement_detail resolves cached ids with 0 API calls", detail.api_calls_this_call === 0, detail);
check("get_engagement_detail returns full records (no errors)", detail.engagements.every((e) => !e.error), detail.engagements.map((e) => e.error || "ok"));

console.log("\n-- get_engagement_detail: unknown id (expect a live fetch attempt) --");
const detailMiss = await callTool(clientA, "get_engagement_detail", { engagement_ids: ["THIS_ID_DOES_NOT_EXIST_00000000"] });
check("get_engagement_detail attempts a live fetch for a cache miss", detailMiss.api_calls_this_call > 0, detailMiss);
check("get_engagement_detail reports not-found cleanly", detailMiss.engagements[0].error, detailMiss.engagements[0]);

await clientA.close();

// ---- Process B: simulated restart, same store path ----
console.log("\n== Process B: simulated Claude Desktop restart (same store file) ==");
let { client: clientB } = await connect();

console.log("\n-- find_account_conversations: RESTART (backfill already done, expect cache hit, 0 API calls) --");
const restart = await callTool(clientB, "find_account_conversations", { accounts: ["Atlassian"] });
check("restart reads persisted store from disk", restart.store.record_count === lastResult.store.record_count, { restart: restart.store, lastResult: lastResult.store });
check("restart makes 0 API calls (no re-scan, backfill already persisted complete)", restart.store.api_calls_this_call === 0, restart.store);
check("restart source is cache", restart.store.source === "cache", restart.store);
check("restart shows backfill_complete persisted as true", restart.store.backfill_complete === true, restart.store);

console.log("\n-- force_refresh: true (expect a sync even though fresh) --");
const forced = await callTool(clientB, "find_account_conversations", { accounts: ["Atlassian"], force_refresh: true });
check("force_refresh triggers a sync", forced.store.source.startsWith("synced"), forced.store);
check("force_refresh makes >0 API calls", forced.store.api_calls_this_call > 0, forced.store);
console.log(`  force_refresh sync reason: ${forced.store.source}, api_calls=${forced.store.api_calls_this_call}`);

console.log("\n-- max_age_minutes: 0 (expect auto-sync on next call regardless of freshness) --");
const staleForced = await callTool(clientB, "find_account_conversations", { accounts: ["Atlassian"], max_age_minutes: 0 });
check("max_age_minutes:0 triggers a sync", staleForced.store.source.startsWith("synced"), staleForced.store);
check("max_age_minutes:0 makes >0 API calls", staleForced.store.api_calls_this_call > 0, staleForced.store);

console.log("\n-- confirm normal warm call after all that is cache-only again --");
const finalWarm = await callTool(clientB, "find_account_conversations", { accounts: ["Atlassian"] });
check("final warm call is cache, 0 API calls", finalWarm.store.source === "cache" && finalWarm.store.api_calls_this_call === 0, finalWarm.store);

await clientB.close();

console.log(`\n${passCount} passed, ${failCount} failed`);
if (failCount > 0) process.exit(1);
