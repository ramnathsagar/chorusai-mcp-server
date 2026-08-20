// store.js — on-disk JSON persistence + sync orchestration for the Chorus engagements firehose.
//
// Why a JSON file instead of SQLite: account/domain matching (lib.js) is fuzzy (normalized
// substring/domain-root checks) and can't be expressed as a SQL WHERE clause, so either backend
// ends up loading every record into memory and filtering in JS. This is also a single Node
// process (stdio server) — "concurrent tool calls" means concurrent async calls within one event
// loop, which the in-flight sync lock below handles without needing a database's transactional
// guarantees. A JSON file avoids a compiled native dependency entirely.
//
// Read-only against Chorus: this module only ever calls the GET helpers in chorus-client.js.
// Never logs or persists the API key.
//
// Historical backfill vs. per-call latency: Chorus returns the firehose newest-first with no
// direct jump-to-date. Reaching far back in history means walking many pages, but any single
// call needs to stay well under an MCP client's request timeout (chorus-client.js's
// CHORUS_MAX_PAGES bounds that per call). So backfill is INCREMENTAL ACROSS CALLS: each sync()
// resumes from a persisted cursor and walks up to CHORUS_MAX_PAGES pages further back, until
// either CHORUS_MAX_HISTORY_PAGES total is reached or the true start of the firehose is hit —
// at which point `backfill_complete` flips true and steady-state (fast, usually incremental)
// syncing takes over. Until backfill completes, ensureFresh() triggers a sync on every call
// regardless of max_age, so the depth is reached within the first few tool calls of a session
// rather than waiting on the freshness window.
//
// Env:
//   CHORUS_STORE_PATH       (default ~/Library/Application Support/chorusai-mcp-server/engagements.json)
//   CHORUS_MAX_AGE_MINUTES  (default 60) — how stale the store may be before an auto-sync
//   CHORUS_MAX_HISTORY_PAGES (default 150) — total backfill depth target, reached across several
//                             CHORUS_MAX_PAGES-sized calls (150 pages ≈ well over a year at
//                             typical volumes — see README's paging-cap note for the tradeoffs)

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { apiGetRaw, fetchEngagements } from "./chorus-client.js";

const STORE_PATH =
  process.env.CHORUS_STORE_PATH ||
  `${homedir()}/Library/Application Support/chorusai-mcp-server/engagements.json`;
const DEFAULT_MAX_AGE_MS = Math.max(1, parseInt(process.env.CHORUS_MAX_AGE_MINUTES || "60", 10)) * 60_000;
const MAX_HISTORY_PAGES = Math.max(1, parseInt(process.env.CHORUS_MAX_HISTORY_PAGES || "150", 10));
const STORE_VERSION = 2;

let loaded = false;
let engagementsById = new Map();
let meta = defaultMeta();
let syncInFlight = null;

function defaultMeta() {
  return {
    last_synced_at: null,
    newest_seen_iso: null,
    date_filter_honored: null,
    backfill_complete: false,
    backfill_cursor: null,
    backfill_pages_done: 0,
  };
}

async function load() {
  if (loaded) return;
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    engagementsById = new Map(Object.entries(parsed.engagements || {}));
    meta = {
      last_synced_at: parsed.last_synced_at || null,
      newest_seen_iso: parsed.newest_seen_iso || null,
      date_filter_honored: parsed.date_filter_honored ?? null,
      backfill_complete: parsed.backfill_complete ?? false,
      backfill_cursor: parsed.backfill_cursor ?? null,
      backfill_pages_done: parsed.backfill_pages_done ?? 0,
    };
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    engagementsById = new Map();
    meta = defaultMeta();
  }
  loaded = true;
}

async function persist() {
  const state = {
    version: STORE_VERSION,
    ...meta,
    engagements: Object.fromEntries(engagementsById),
  };
  await mkdir(dirname(STORE_PATH), { recursive: true });
  const tmpPath = `${STORE_PATH}.tmp`;
  await writeFile(tmpPath, JSON.stringify(state), "utf8");
  await rename(tmpPath, STORE_PATH);
}

function upsert(list) {
  let newestMs = meta.newest_seen_iso ? Date.parse(meta.newest_seen_iso) : 0;
  for (const e of list) {
    if (!e || !e.engagement_id) continue;
    engagementsById.set(e.engagement_id, e);
    let dtMs = Number(e.date_time);
    if (isFinite(dtMs)) {
      if (dtMs < 1e12) dtMs *= 1000;
      if (dtMs > newestMs) newestMs = dtMs;
    }
  }
  if (newestMs > 0) meta.newest_seen_iso = new Date(newestMs).toISOString();
}

/** One-time, cheap probe: does min_date actually narrow results server-side? Uses the freshly
 * loaded dataset to pick a realistic threshold, so it costs exactly one extra request. */
async function probeDateFilterHonored(requestCounter) {
  if (!meta.newest_seen_iso) return null;
  const newestMs = Date.parse(meta.newest_seen_iso);
  const thresholdMs = newestMs - 7 * 86400_000;
  if (thresholdMs <= 0) return null;
  const thresholdIso = new Date(thresholdMs).toISOString();
  if (requestCounter) requestCounter.count++;
  const { status, body } = await apiGetRaw("engagements", { min_date: thresholdIso });
  if (status < 200 || status >= 300) return null;
  const list = Array.isArray(body?.engagements) ? body.engagements : [];
  if (!list.length) return null;
  const allWithinWindow = list.every((e) => {
    let dtMs = Number(e.date_time);
    if (!isFinite(dtMs)) return true;
    if (dtMs < 1e12) dtMs *= 1000;
    return dtMs >= thresholdMs - 60_000; // 1min slack for clock/rounding
  });
  return allWithinWindow;
}

/**
 * doSync(): while backfill isn't complete, resumes the historical walk from `backfill_cursor` for
 * up to CHORUS_MAX_PAGES more pages (bounded latency), and checks whether that reached
 * CHORUS_MAX_HISTORY_PAGES total or the true start of the firehose. Once backfill_complete,
 * switches to steady-state: incremental (min_date = last watermark) if that's confirmed honored,
 * else a bounded full re-scan. Either way, whatever pages complete before an error (e.g.
 * persistent 429) are still merged and persisted in the `finally` block — no all-or-nothing loss.
 */
async function doSync({ requestCounter }) {
  const isFirstSync = engagementsById.size === 0;
  let result = { engagements: [], pages: 0, capped: false };
  let reason;
  try {
    if (!meta.backfill_complete) {
      result = await fetchEngagements({ server: {}, requestCounter, startCursor: meta.backfill_cursor });
      upsert(result.engagements);
      meta.backfill_pages_done += result.pages;
      meta.backfill_cursor = result.nextCursor;
      meta.backfill_complete = result.exhausted || meta.backfill_pages_done >= MAX_HISTORY_PAGES;
      reason = isFirstSync ? "initial_backfill" : meta.backfill_complete ? "backfill_complete" : "backfill_continuing";
      if (meta.date_filter_honored == null && meta.newest_seen_iso) {
        meta.date_filter_honored = await probeDateFilterHonored(requestCounter);
      }
    } else {
      const incremental = meta.date_filter_honored === true && meta.newest_seen_iso;
      const server = incremental ? { min_date: meta.newest_seen_iso } : {};
      result = await fetchEngagements({ server, requestCounter });
      upsert(result.engagements);
      reason = incremental ? "incremental" : "full_rescan";
    }
    meta.last_synced_at = new Date().toISOString();
    return {
      synced: true,
      reason,
      pages: result.pages,
      capped: result.capped,
      fetched: result.engagements.length,
      backfill_complete: meta.backfill_complete,
      backfill_pages_done: meta.backfill_pages_done,
      history_target_pages: MAX_HISTORY_PAGES,
    };
  } finally {
    await persist();
  }
}

/**
 * ensureFresh(): syncs when forced, empty, stale past maxAgeMs, OR while historical backfill is
 * still incomplete (so depth is reached within the first few calls of a session, not gated on the
 * freshness window). Concurrent callers share one in-flight sync instead of triggering duplicates.
 */
export async function ensureFresh({ forceRefresh = false, maxAgeMs = DEFAULT_MAX_AGE_MS, requestCounter = null } = {}) {
  await load();
  const ageMs = meta.last_synced_at ? Date.now() - Date.parse(meta.last_synced_at) : Infinity;
  const needsSync = forceRefresh || !meta.last_synced_at || ageMs > maxAgeMs || !meta.backfill_complete;
  if (!needsSync) {
    return { synced: false, reason: "fresh", age_ms: ageMs, record_count: engagementsById.size, backfill_complete: meta.backfill_complete };
  }
  if (!syncInFlight) {
    syncInFlight = doSync({ requestCounter }).finally(() => { syncInFlight = null; });
  }
  const outcome = await syncInFlight;
  return { ...outcome, record_count: engagementsById.size };
}

export async function getAllEngagements() {
  await load();
  return Array.from(engagementsById.values());
}

export async function getByIds(ids) {
  await load();
  const found = [];
  const missing = [];
  for (const id of ids) {
    const e = engagementsById.get(id);
    if (e) found.push(e);
    else missing.push(id);
  }
  return { found, missing };
}

export async function upsertAndPersist(list) {
  await load();
  upsert(list);
  await persist();
}

export async function storeStats() {
  await load();
  const ageMs = meta.last_synced_at ? Date.now() - Date.parse(meta.last_synced_at) : null;
  return {
    store_path: STORE_PATH,
    record_count: engagementsById.size,
    last_synced_at: meta.last_synced_at,
    age_ms: ageMs,
    date_filter_honored: meta.date_filter_honored,
    backfill_complete: meta.backfill_complete,
    backfill_pages_done: meta.backfill_pages_done,
    history_target_pages: MAX_HISTORY_PAGES,
  };
}

export { STORE_PATH, DEFAULT_MAX_AGE_MS, MAX_HISTORY_PAGES };
