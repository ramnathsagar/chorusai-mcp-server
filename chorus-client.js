// chorus-client.js — thin GET-only client for the Chorus (ZoomInfo) APIs.
// Shared by index.js (live tool calls) and store.js (background sync). Read-only: no writes,
// no deletes, never logs or persists the API key.
//
// Env:
//   CHORUS_API_KEY    (required)
//   CHORUS_BASE_URL   (default https://chorus.ai/v3)
//   CHORUS_TRANSCRIPT_BASE_URL (default https://chorus.ai/api/v1)
//   CHORUS_PAGE_PARAM (default continuation_key)
//   CHORUS_MAX_PAGES  (default 40) — safety cap on pages fetched in a SINGLE fetchEngagements
//                      call, so any one tool call stays comfortably under an MCP client's request
//                      timeout. This is NOT the total historical depth the store keeps — see
//                      store.js's CHORUS_MAX_HISTORY_PAGES, which reaches further back across
//                      several calls via a resumable cursor instead of one slow call.
//   CHORUS_PAGE_DELAY_MS (default 120)

const API_KEY = process.env.CHORUS_API_KEY;
export const BASE_URL = (process.env.CHORUS_BASE_URL || "https://chorus.ai/v3").replace(/\/+$/, "");
export const TRANSCRIPT_BASE_URL = (process.env.CHORUS_TRANSCRIPT_BASE_URL || "https://chorus.ai/api/v1").replace(/\/+$/, "");
export const PAGE_PARAM = process.env.CHORUS_PAGE_PARAM || "continuation_key";
export const MAX_PAGES = Math.max(1, parseInt(process.env.CHORUS_MAX_PAGES || "40", 10));
export const PAGE_DELAY_MS = Math.max(0, parseInt(process.env.CHORUS_PAGE_DELAY_MS || "120", 10));

if (!API_KEY) {
  console.error("CHORUS_API_KEY is not set. Add it to the MCP server config env. Exiting.");
  process.exit(1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TRANSCRIPT_FIELDS = [
  "name",
  "status",
  "language",
  "private",
  "account",
  "deal",
  "owner",
  "participants",
  "recording",
  "recording.duration",
  "recording.start_time",
  "recording.utterances",
].join(",");

export function rateHeaders(headers) {
  const h = (k) => headers.get(k);
  const out = {
    limit: h("ratelimit-limit") ?? h("x-ratelimit-limit") ?? null,
    remaining: h("ratelimit-remaining") ?? h("x-ratelimit-remaining") ?? null,
    reset: h("ratelimit-reset") ?? h("x-ratelimit-reset") ?? null,
    retry_after: h("retry-after") ?? null,
  };
  return Object.values(out).every((v) => v === null) ? null : out;
}

/** Shared GET implementation for both the v3 engagement API and the v1 conversation endpoint.
 * `captureNonJson` is disabled for transcript requests so an unexpected response can never be
 * copied into an error object or log. */
export async function apiGetRawAt(
  baseUrl,
  path,
  params = {},
  {
    retryOn429 = true,
    accept = "application/json",
    captureNonJson = true,
    fetchImpl = globalThis.fetch,
    sleepFn = sleep,
    apiKey = API_KEY,
  } = {},
) {
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  const res = await fetchImpl(url, { method: "GET", headers: { Authorization: apiKey, Accept: accept } });
  const rate = rateHeaders(res.headers);
  if (res.status === 429 && retryOn429) {
    let waitMs = 2000;
    const ra = res.headers.get("retry-after");
    const rr = res.headers.get("ratelimit-reset");
    if (ra && !isNaN(Number(ra))) waitMs = Number(ra) * 1000;
    else if (rr && !isNaN(Number(rr))) waitMs = Number(rr) * 1000;
    waitMs = Math.min(Math.max(waitMs, 1000), 30000);
    await sleepFn(waitMs);
    return apiGetRawAt(baseUrl, path, params, {
      retryOn429: false,
      accept,
      captureNonJson,
      fetchImpl,
      sleepFn,
      apiKey,
    });
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = captureNonJson ? { _nonjson: text.slice(0, 300) } : { _nonjson: true }; }
  return { status: res.status, headers: res.headers, rate, body };
}

export async function apiGetRaw(path, params = {}, options = {}) {
  return apiGetRawAt(BASE_URL, path, params, options);
}

export async function apiGet(path, params = {}) {
  const { status, body } = await apiGetRaw(path, params);
  if (status < 200 || status >= 300) {
    const detail = body?._nonjson || (body?.errors ? JSON.stringify(body.errors) : JSON.stringify(body));
    throw new Error(`Chorus API ${status} on ${path}: ${String(detail).slice(0, 300)}`);
  }
  return body;
}

export function inRange(dt, sinceMs, untilMs) {
  if (sinceMs == null && untilMs == null) return true;
  let n = Number(dt);
  if (!isFinite(n)) return true;
  if (n < 1e12) n *= 1000;
  if (sinceMs != null && n < sinceMs) return false;
  if (untilMs != null && n > untilMs) return false;
  return true;
}

/**
 * Page through /v3/engagements, up to `maxPages` pages in THIS call (default CHORUS_MAX_PAGES —
 * keep this small; it bounds how long a single tool call takes). `server.min_date`/
 * `server.max_date` (ISO-8601 strings) and `server.engagement_type` are sent as opportunistic
 * server-side hints — correctness never depends on Chorus honoring them, since `inRange()`
 * re-filters client-side regardless.
 *
 * Resumable: pass `startCursor` (a previously-returned `nextCursor`) to continue an earlier walk
 * instead of restarting from the newest page — this is how store.js reaches further back in
 * history than any single call's page budget, across several sync() calls. Returns `nextCursor`
 * (null once the true end of the firehose is reached for this query) and `exhausted` (whether
 * that happened in this call, vs. just hitting `maxPages`).
 */
export async function fetchEngagements({ server = {}, sinceMs = null, untilMs = null, requestCounter = null, startCursor = null, maxPages = MAX_PAGES } = {}) {
  const all = [];
  const seen = new Set();
  let cont = startCursor || null, pages = 0, capped = false, lastRate = null, exhausted = false;
  const baseParams = {};
  if (server.min_date) baseParams.min_date = server.min_date;
  if (server.max_date) baseParams.max_date = server.max_date;
  if (server.engagement_type) baseParams.engagement_type = server.engagement_type;

  while (pages < maxPages) {
    const params = { ...baseParams, ...(cont ? { [PAGE_PARAM]: cont } : {}) };
    if (requestCounter) requestCounter.count++;
    const { status, body, rate } = await apiGetRaw("engagements", params);
    if (rate) lastRate = rate;
    if (status < 200 || status >= 300) {
      if (Object.keys(baseParams).length && pages === 0 && !startCursor) {
        for (const k of Object.keys(baseParams)) delete baseParams[k];
        continue;
      }
      throw new Error(`Chorus API ${status} while paging engagements`);
    }
    const list = Array.isArray(body?.engagements) ? body.engagements : [];
    for (const e of list) {
      if (e && e.engagement_id && !seen.has(e.engagement_id) && inRange(e.date_time, sinceMs, untilMs)) {
        seen.add(e.engagement_id); all.push(e);
      }
    }
    pages++;
    const next = body?.continuation_key || null;
    if (!next || list.length === 0 || next === cont) { exhausted = true; cont = null; break; }
    cont = next;
    if (pages >= maxPages) { capped = true; break; }
    if (PAGE_DELAY_MS) await sleep(PAGE_DELAY_MS);
  }
  return { engagements: all, pages, capped, rate: lastRate, nextCursor: exhausted ? null : cont, exhausted };
}

/** Fetch one or more engagements by ID in a single request (engagement_id accepts a
 * comma-separated list per the Chorus docs). */
export async function fetchEngagementsByIds(ids, { requestCounter = null } = {}) {
  if (requestCounter) requestCounter.count++;
  const body = await apiGet("engagements", { engagement_id: ids.join(",") });
  const list = Array.isArray(body?.engagements) ? body.engagements : [];
  return list;
}

/** Fetch a single transcript-bearing v1 conversation. The official endpoint returns the full
 * utterance list in one response; MCP response pagination is therefore applied locally after
 * retrieval rather than sent to Chorus. */
export async function fetchTranscriptConversation(
  engagementId,
  { requestCounter = null, fetchImpl = globalThis.fetch, sleepFn = sleep } = {},
) {
  if (requestCounter) requestCounter.count++;
  return apiGetRawAt(
    TRANSCRIPT_BASE_URL,
    `conversations/${encodeURIComponent(String(engagementId))}`,
    { fields: TRANSCRIPT_FIELDS },
    {
      accept: "application/vnd.api+json",
      captureNonJson: false,
      fetchImpl,
      sleepFn,
    },
  );
}
