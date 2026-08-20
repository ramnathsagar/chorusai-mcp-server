#!/usr/bin/env node
// chorusai-mcp-server v1.2 — local, read-only MCP server for account-centric Chorus (ZoomInfo) v3
// conversation data (metadata + AI summaries + action items). Verbatim transcripts = v2.
//
// v1.2 adds: a persistent on-disk store (store.js) so account queries stop re-scanning the whole
// engagements firehose on every call and after every Claude Desktop restart, plus fixes to match
// the actual documented Chorus v3 query params (min_date/max_date, engagement_type) instead of
// unconfirmed 2024-era guesses (created_at_start/created_at_end, object_type).
//
// Env:
//   CHORUS_API_KEY          (required)
//   CHORUS_BASE_URL         (default https://chorus.ai/v3)
//   CHORUS_PAGE_PARAM       (default continuation_key)
//   CHORUS_MAX_PAGES        (default 40) — per-call safety cap, keeps any one tool call fast.
//   CHORUS_PAGE_DELAY_MS    (default 120)
//   CHORUS_STORE_PATH       (default ~/Library/Application Support/chorusai-mcp-server/engagements.json)
//   CHORUS_MAX_AGE_MINUTES  (default 60)
//   CHORUS_MAX_HISTORY_PAGES (default 150) — total backfill depth target, reached gradually
//                            across several calls (see store.js). Raise this — not CHORUS_MAX_PAGES
//                            — if a long-tenured account's earliest discovery-call evidence still
//                            looks thin once backfill_complete is true.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { groupByAccount, detailRow } from "./lib.js";
import { apiGetRaw, fetchEngagementsByIds, inRange, sleep, PAGE_DELAY_MS, MAX_PAGES, BASE_URL } from "./chorus-client.js";
import { ensureFresh, getAllEngagements, getByIds, upsertAndPersist, storeStats } from "./store.js";

const jsonContent = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const dateToMs = (s) => { const d = new Date(s); return isNaN(d) ? null : d.getTime(); };
const toIsoZ = (s) => { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); };

/** Explains what a sync's `capped`/backfill state actually means for THIS call, so "capped"
 * never reads as alarming when it's just normal backfill-in-progress, and does read as a real
 * heads-up when a long-tenured account's discovery-stage history may genuinely be out of reach. */
function syncNote(sync) {
  if (!sync.capped) return undefined;
  if (!sync.backfill_complete) {
    return `Still building historical backfill: ${sync.backfill_pages_done}/${sync.history_target_pages} pages so far. This continues automatically on the next call — older conversations for long-tenured accounts may not be visible yet, but this isn't a final gap.`;
  }
  return `Historical backfill already reached its ${sync.history_target_pages}-page target, but THIS refresh alone still hit the ${MAX_PAGES}-page per-call cap (run diagnose_filters to see whether that's because min_date isn't honored, forcing a full re-scan, or just an unusually large burst of new activity). Chorus returns records newest-first, so if a long-tenured account's EARLIEST conversations — often the discovery call — still look thin, raise CHORUS_MAX_HISTORY_PAGES.`;
}

const TOOLS = [
  {
    name: "chorus_health",
    description: "Connectivity + auth smoke test. Fetches one live page of engagements and reports whether the token works, first-page count, live rate-limit headers (limit/remaining/reset) if Chorus exposes them, and the local persisted-store status (record count, last sync, whether date filters are known to be honored).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const { status, body, rate } = await apiGetRaw("engagements");
      const list = Array.isArray(body?.engagements) ? body.engagements : [];
      return jsonContent({
        ok: status >= 200 && status < 300,
        http_status: status,
        base_url: BASE_URL,
        first_page_engagements: list.length,
        has_more: Boolean(body?.continuation_key),
        rate_limit: rate || "no rate-limit headers exposed by Chorus on this response",
        store: await storeStats(),
        note: "Auth OK if ok=true. Only engagements your Chorus user can access are visible.",
      });
    },
  },
  {
    name: "diagnose_filters",
    description: "Empirically test which server-side query params the /v3/engagements endpoint honors on THIS instance, using the param names actually documented by Chorus (min_date/max_date, engagement_type, participants_email) rather than unconfirmed guesses. Verifies by inspecting the CONTENT of filtered pages (not just result counts, which are unreliable once both filtered and unfiltered pages hit the 100-record page size). Also verifies there is still no account/opportunity filter (object_type/object_id), as the current docs state. Read-only; ~7 single-page calls.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const probe = async (label, params, contentCheck) => {
        const { status, body, rate } = await apiGetRaw("engagements", params);
        const list = Array.isArray(body?.engagements) ? body.engagements : [];
        await sleep(PAGE_DELAY_MS);
        let appears_to_filter;
        if (status >= 400) appears_to_filter = "ERROR";
        else if (!contentCheck) appears_to_filter = list.length < baseCount ? "yes (fewer results than baseline)" : "no (same as baseline — likely ignored)";
        else if (list.length === 0) appears_to_filter = "inconclusive (no results returned to check)";
        else appears_to_filter = list.every(contentCheck)
          ? "yes (every returned record matches the filter)"
          : "no (results include records outside the filter — ignored server-side)";
        return { label, params_sent: Object.keys(params), http_status: status, results_on_page: list.length, has_more: Boolean(body?.continuation_key), appears_to_filter, rate: rate || null };
      };
      const base = await apiGetRaw("engagements");
      const baseList = Array.isArray(base.body?.engagements) ? base.body.engagements : [];
      const baseCount = baseList.length;
      const sample = baseList[0] || {};
      const acctId = sample.account_id || null;
      const oppId = sample.opportunity_id || null;
      const prospect = (sample.participants || []).find((p) => p && p.type !== "rep" && p.email && p.email.includes("@"));
      const prospectEmail = prospect ? prospect.email : null;
      const nowMs = Date.now();
      const sevenDaysAgoMs = nowMs - 7 * 86400_000;
      const nowIso = new Date(nowMs).toISOString();
      const sevenDaysAgoIso = new Date(sevenDaysAgoMs).toISOString();
      const dtMs = (e) => { let n = Number(e.date_time); if (!isFinite(n)) return null; return n < 1e12 ? n * 1000 : n; };
      const slackMs = 60_000; // tolerate clock/rounding

      const results = [];
      results.push({ label: "baseline (no filter)", results_on_page: baseCount, has_more: Boolean(base.body?.continuation_key), rate: base.rate || null });
      results.push(await probe("engagement_type=meeting", { engagement_type: "meeting" }, (e) => e.engagement_type === "meeting"));
      results.push(await probe("min_date=last7d (documented param)", { min_date: sevenDaysAgoIso }, (e) => { const t = dtMs(e); return t == null || t >= sevenDaysAgoMs - slackMs; }));
      results.push(await probe("min_date+max_date=last7d (documented params)", { min_date: sevenDaysAgoIso, max_date: nowIso }, (e) => { const t = dtMs(e); return t == null || (t >= sevenDaysAgoMs - slackMs && t <= nowMs + slackMs); }));
      if (prospectEmail) results.push(await probe("participants_email=<prospect on page1> (documented param)", { participants_email: prospectEmail }, (e) => (e.participants || []).some((p) => p.email === prospectEmail)));
      if (acctId) results.push(await probe("object_type=account&object_id=<acctId> (undocumented as of current docs; testing anyway)", { object_type: "account", object_id: acctId }));
      if (oppId) results.push(await probe("object_type=opportunity&object_id=<oppId> (undocumented as of current docs; testing anyway)", { object_type: "opportunity", object_id: oppId }));

      return jsonContent({
        baseline_full_page: baseCount,
        had_sample_account_id: Boolean(acctId),
        had_sample_participant_email: Boolean(prospectEmail),
        variants: results,
        how_to_read: "appears_to_filter='yes' => honored server-side, verified by checking every returned record actually matches (not just a smaller count, which is unreliable once pages hit the 100-record cap). 'no' => ignored (client-side filtering still applies, and the persistent store falls back to full rescans). 'ERROR' => rejected. Per the current Chorus API docs (api-docs.chorus.ai), there is no account/opportunity filter for this endpoint — the object_type/object_id probes above are expected to be ignored or errored, and can only be checked by count since there's no content signature to verify against.",
      });
    },
  },
  {
    name: "find_account_conversations",
    description: "Given account names and/or email domains, return a COMPACT index of every engagement for the matched customer accounts (all stages). Matching uses the customer/prospect side only. Reads from a local persisted store that's synced from Chorus on a freshness schedule (see max_age_minutes/force_refresh) instead of re-scanning the live API on every call.",
    inputSchema: {
      type: "object",
      properties: {
        accounts: { type: "array", items: { type: "string" }, description: 'Names and/or domains, e.g. ["ADT","Life360","acme.com"].' },
        fit_label: { type: "string", enum: ["good_fit", "bad_fit", "unlabeled"] },
        since: { type: "string", description: "ISO date lower bound, e.g. 2026-01-01 (optional)." },
        until: { type: "string", description: "ISO date upper bound (optional)." },
        meetings_only: { type: "boolean", default: false },
        force_refresh: { type: "boolean", default: false, description: "Force a fresh sync from Chorus before answering, even if the local store is fresh." },
        max_age_minutes: { type: "integer", description: "How stale the local store may be before auto-syncing (default: CHORUS_MAX_AGE_MINUTES env, 60). 0 forces a freshness check that always syncs." },
      },
      required: ["accounts"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const accounts = (args.accounts || []).map(String).filter(Boolean);
      if (!accounts.length) throw new Error("Provide at least one account name or domain.");
      const sinceMs = args.since ? dateToMs(args.since) : null;
      const untilMs = args.until ? dateToMs(args.until) : null;
      const requestCounter = { count: 0 };
      const sync = await ensureFresh({
        forceRefresh: Boolean(args.force_refresh),
        maxAgeMs: args.max_age_minutes != null ? Math.max(0, args.max_age_minutes) * 60_000 : undefined,
        requestCounter,
      });
      let engagements = await getAllEngagements();
      if (sinceMs != null || untilMs != null) engagements = engagements.filter((e) => inRange(e.date_time, sinceMs, untilMs));
      let groups = groupByAccount(engagements, accounts, "index");
      if (args.meetings_only) for (const g of groups) g.engagements = g.engagements.filter((e) => e.type === "meeting");
      groups = groups.filter((g) => g.engagements.length > 0);
      const matched = new Set(groups.map((g) => g.matched_as));
      return jsonContent({
        fit_label: args.fit_label || "unlabeled",
        requested: accounts,
        unmatched_accounts: accounts.filter((a) => !matched.has(a)),
        window: { since: args.since || null, until: args.until || null },
        store: {
          total_cached_engagements: engagements.length,
          source: sync.synced ? `synced (${sync.reason})` : "cache",
          record_count: sync.record_count,
          pages_fetched_this_call: sync.pages || 0,
          capped: Boolean(sync.capped),
          backfill_complete: sync.backfill_complete,
          backfill_pages_done: sync.backfill_pages_done,
          api_calls_this_call: requestCounter.count,
        },
        accounts: groups,
        note: syncNote(sync),
      });
    },
  },
  {
    name: "get_account_brief",
    description: "The main ICP tool. For the given accounts (names/domains), return the FULL distilled record per matched engagement across all stages — AI meeting_summary, action_items, participants, opportunity — bundled per account, chronological. Optional since/until date bounds. Reads from the local persisted store (see max_age_minutes/force_refresh). Verbatim transcripts not included (v2).",
    inputSchema: {
      type: "object",
      properties: {
        accounts: { type: "array", items: { type: "string" } },
        fit_label: { type: "string", enum: ["good_fit", "bad_fit", "unlabeled"] },
        since: { type: "string", description: "ISO lower bound (optional)." },
        until: { type: "string", description: "ISO upper bound (optional)." },
        include_emails: { type: "boolean", default: true },
        recorded_meetings_only: { type: "boolean", default: false },
        max_engagements_per_account: { type: "integer", default: 40 },
        force_refresh: { type: "boolean", default: false, description: "Force a fresh sync from Chorus before answering, even if the local store is fresh." },
        max_age_minutes: { type: "integer", description: "How stale the local store may be before auto-syncing (default: CHORUS_MAX_AGE_MINUTES env, 60). 0 forces a freshness check that always syncs." },
      },
      required: ["accounts"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const accounts = (args.accounts || []).map(String).filter(Boolean);
      if (!accounts.length) throw new Error("Provide at least one account name or domain.");
      const includeEmails = args.include_emails !== false;
      const recordedOnly = args.recorded_meetings_only === true;
      const cap = Math.max(1, parseInt(args.max_engagements_per_account ?? 40, 10));
      const sinceMs = args.since ? dateToMs(args.since) : null;
      const untilMs = args.until ? dateToMs(args.until) : null;
      const requestCounter = { count: 0 };
      const sync = await ensureFresh({
        forceRefresh: Boolean(args.force_refresh),
        maxAgeMs: args.max_age_minutes != null ? Math.max(0, args.max_age_minutes) * 60_000 : undefined,
        requestCounter,
      });
      let engagements = await getAllEngagements();
      if (sinceMs != null || untilMs != null) engagements = engagements.filter((e) => inRange(e.date_time, sinceMs, untilMs));
      let groups = groupByAccount(engagements, accounts, "detail");
      let trimmedAny = false;
      for (const g of groups) {
        let items = g.engagements;
        if (!includeEmails) items = items.filter((e) => e.type !== "email");
        if (recordedOnly) items = items.filter((e) => e.recorded);
        if (items.length > cap) { items = items.slice(0, cap); trimmedAny = true; }
        g.engagements = items;
        g.counts = { returned: items.length, recorded_meetings: items.filter((e) => e.recorded).length, with_summary: items.filter((e) => e.meeting_summary).length };
      }
      groups = groups.filter((g) => g.engagements.length > 0);
      const matched = new Set(groups.map((g) => g.matched_as));
      return jsonContent({
        fit_label: args.fit_label || "unlabeled",
        requested: accounts,
        unmatched_accounts: accounts.filter((a) => !matched.has(a)),
        window: { since: args.since || null, until: args.until || null },
        store: {
          total_cached_engagements: engagements.length,
          source: sync.synced ? `synced (${sync.reason})` : "cache",
          record_count: sync.record_count,
          pages_fetched_this_call: sync.pages || 0,
          capped: Boolean(sync.capped),
          backfill_complete: sync.backfill_complete,
          backfill_pages_done: sync.backfill_pages_done,
          api_calls_this_call: requestCounter.count,
        },
        accounts: groups,
        notes: [
          syncNote(sync),
          trimmedAny ? "Some accounts trimmed to max_engagements_per_account." : null,
          "v1 provides AI summaries + action items, not verbatim transcripts.",
        ].filter(Boolean),
      });
    },
  },
  {
    name: "get_engagement_detail",
    description: "Fetch the full distilled record for one or more engagement_ids: AI meeting_summary, action_items, participants, opportunity, metrics. Checks the local store first and only calls Chorus (in a single batched request) for ids it doesn't already have.",
    inputSchema: { type: "object", properties: { engagement_ids: { type: "array", items: { type: "string" } } }, required: ["engagement_ids"], additionalProperties: false },
    handler: async (args) => {
      const ids = (args.engagement_ids || []).map(String).filter(Boolean);
      if (!ids.length) throw new Error("Provide at least one engagement_id.");
      const requestCounter = { count: 0 };
      const { found, missing } = await getByIds(ids);
      let fetched = [];
      if (missing.length) {
        try {
          fetched = await fetchEngagementsByIds(missing, { requestCounter });
          if (fetched.length) await upsertAndPersist(fetched);
        } catch (err) {
          fetched = [{ _error: String(err.message || err) }];
        }
      }
      const byId = new Map();
      for (const e of [...found, ...fetched]) if (e && e.engagement_id) byId.set(e.engagement_id, e);
      const out = ids.map((id) => {
        const e = byId.get(id);
        return e ? detailRow(e) : { engagement_id: id, error: "not found or not accessible" };
      });
      return jsonContent({ engagements: out, api_calls_this_call: requestCounter.count });
    },
  },
];

const server = new Server({ name: "chorusai-mcp-server", version: "1.2.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);
  try { return await tool.handler(req.params.arguments || {}); }
  catch (err) { return { isError: true, content: [{ type: "text", text: `Error in ${tool.name}: ${String(err.message || err)}` }] }; }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("chorusai-mcp-server v1.2 running (stdio). Tools: chorus_health, diagnose_filters, find_account_conversations, get_account_brief, get_engagement_detail.");
