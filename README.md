# chorusai-mcp-server (v1.2)

A **local, read-only** MCP server that gives Claude account-centric access to your Chorus
(ZoomInfo) conversation data, for ICP analysis. It groups every engagement with a customer
account — across all deal stages — and returns Chorus's AI **meeting summaries, action items,
participants, and topics**, so the ICP-builder skill can trace recurring pain, value-prop
resonance, and good-fit vs bad-fit patterns.

> **v1 scope:** metadata + AI summaries + action items (endpoints we verified on `/v3`).
> **Not in v1:** verbatim call transcripts — that needs the recording endpoint confirmed with
> your ZoomInfo CSM. Once you have it, it slots in as a `get_transcript` tool.
>
> **v1.2** adds a persistent local store so account queries no longer re-scan the entire
> engagements firehose on every call and after every Claude Desktop restart — see
> [Persistence](#persistence) below.

## What it talks to
- `GET https://chorus.ai/v3/engagements` (paged via `continuation_key`) — the firehose, synced
  into the local store and filtered/matched in memory.
- `GET https://chorus.ai/v3/engagements?engagement_id=<a>,<b>,...` — batch fetch by ID (the API
  accepts a comma-separated list) for anything not already in the store.
- Auth: your personal token as a raw `Authorization` header (no `Bearer`). Nothing is written; no
  deletes.

### Confirmed against the current Chorus API docs (api-docs.chorus.ai)
Pulled directly from the underlying Postman collection, since the docs page itself is
JS-rendered. A few things differ from earlier assumptions — corrected here:
- **Pagination**: request param is `continuation_key` — as before, unchanged.
- **Date filtering**: the documented (and, live-verified with this token, actually **honored**)
  params are **`min_date` / `max_date`, ISO-8601 strings** — not `created_at_start`/
  `created_at_end` (epoch), which never existed in the docs and were being silently ignored.
- **Type filtering**: **`engagement_type`** (e.g. `meeting`) is the real, documented, and
  live-verified-honored param — not `object_type`, which isn't a real filter for this endpoint.
- **Participant filtering**: **`participants_email`** (plural) — confirmed honored live.
- **No account/opportunity server-side filter exists** for `/v3/engagements` (no `object_type`/
  `object_id` for accounts — those only appear elsewhere, in unrelated CRM-sync payloads). There is
  also **no accounts/search endpoint anywhere in the API**. Client-side matching over engagements
  remains structurally required — this is exactly what the persistent store amortizes.
- **Rate limits**: nothing numeric is documented. We keep defensive 429/retry-after handling and
  surface whatever `ratelimit-*` headers Chorus actually returns via `chorus_health`.

Run **`diagnose_filters`** any time to re-verify all of the above live against your own token —
it checks the *content* of filtered pages (not just result counts, which are meaningless once
both filtered and unfiltered pages hit the 100-record page size).

## Setup (macOS, Claude Desktop)
1. Put this folder at `~/chorusai-mcp-server` (or wherever you like — just point the config below at it).
2. Install the one dependency and print your config:
   ```bash
   cd ~/chorusai-mcp-server
   ./setup.sh
   ```
3. Copy the printed block into **Claude Desktop → Settings → Developer → Edit Config**, paste your
   API token where shown, save, and fully quit + reopen Claude Desktop (Cmd+Q).
4. In a chat, open the **"+" → Connectors** menu and confirm **chorusai-mcp-server** is listed.

Manual config (if you prefer):
```json
{
  "mcpServers": {
    "chorusai-mcp-server": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/YOU/chorusai-mcp-server/index.js"],
      "env": { "CHORUS_API_KEY": "YOUR_API_KEY" }
    }
  }
}
```
Use the full path from `which node` (Desktop uses a minimal PATH). Node 18+ required.

## Tools
- **chorus_health** — auth/connectivity smoke test. Also reports the local store's status (record
  count, last sync time, whether date filters are confirmed honored). Run first if anything looks
  off.
- **diagnose_filters** — empirically confirms which server-side query params this Chorus instance
  actually honors, checking real content rather than just counts.
- **find_account_conversations** — `accounts: ["ADT","Life360","acme.com"]` → compact index of
  every engagement for the matched customer accounts (id, date, type, recorded?, subject, summary?).
- **get_account_brief** — the main one. Same input → full per-account bundle with AI summaries,
  action items, participants, opportunity, ordered chronologically. Feed this to the ICP skill.
- **get_engagement_detail** — `engagement_ids: [...]` → full record for specific engagements.
  Checked against the local store first; only fetches ids it doesn't already have.

Matching uses the **customer (prospect) side only**, so your own reps/domain never cause matches.
Names are fuzzy ("Atlassian" ↔ "Atlassian, Inc."); domains match prospect email domains.

### Freshness controls
`find_account_conversations` and `get_account_brief` both accept two optional args:
- `force_refresh: true` — sync from Chorus before answering, even if the store is fresh.
- `max_age_minutes: N` — how stale the store may be before auto-syncing for this call
  (`0` means "always sync"). Defaults to `CHORUS_MAX_AGE_MINUTES`.

## Persistence
Every account query used to page through the *entire* engagements firehose (thousands of records)
because there's no accounts endpoint and no confirmed account filter. v1.2 fixes this with a small
on-disk JSON store, kept fresh on a schedule instead of re-scanned per query:

- **Location**: `~/Library/Application Support/chorusai-mcp-server/engagements.json` by default,
  overridable with `CHORUS_STORE_PATH`. Keyed by `engagement_id`; written atomically (temp file +
  rename) so a crash mid-write can't corrupt it.
- **Sync strategy**: on first use (or after `CHORUS_MAX_AGE_MINUTES` elapses, or `force_refresh`),
  the server syncs from Chorus. If `min_date` is confirmed honored (it is, on this token — see
  `diagnose_filters`), sync fetches only what's newer than the last-seen record — cheap. If a
  future token/instance doesn't honor it, sync automatically falls back to a full re-scan instead;
  either way this only happens once per freshness window, not once per query.
- **Historical backfill is spread across calls, not done in one shot.** Chorus returns the
  firehose newest-first with no jump-to-date, so reaching far back means walking many pages — but
  any single call has to stay well under an MCP client's request timeout. So the FIRST several
  calls each walk `CHORUS_MAX_PAGES` pages further back (resuming from a persisted cursor) until
  `CHORUS_MAX_HISTORY_PAGES` total is reached or the true start of the firehose is hit
  (`backfill_complete` flips to `true` in the tool output's `store` field once that happens).
  Until then, every call keeps deepening the backfill regardless of `max_age_minutes` — after it
  completes, normal freshness-window syncing takes over. A named account whose relationship
  predates `backfill_complete` being reached may be missing its earliest (discovery-call)
  evidence until a later call finishes the backfill — the tool output's `note` field says so
  explicitly when that's still in progress.
- **Why JSON and not SQLite**: the account/domain matching in `lib.js` is fuzzy (normalized
  substring and domain-root checks) and can't be expressed as a SQL `WHERE` clause, so either
  backend ends up loading everything into memory and filtering in JS — SQLite's indexing
  advantage doesn't apply here. This is also a single Node process, so "concurrent tool calls"
  means concurrent async calls within one event loop, which an in-memory in-flight-sync lock
  handles without needing a database's transactional guarantees. A JSON file avoids adding a
  compiled native dependency for no real benefit at this scale (thousands of records).
- **Known limitation**: no cross-process file locking. If two separate processes point at the
  same store file and sync concurrently, the last writer wins for that sync — it self-heals on
  the next sync and never corrupts the file (atomic rename), but isn't a correctness guarantee
  across truly concurrent processes. Not a concern for the normal single-Claude-Desktop-connection
  use case.
- **Tradeoff to know**: a call edited in Chorus after it's cached won't show updated content until
  the next sync. Use `force_refresh: true` when you need guaranteed-current data.

## Config knobs (env, all optional)
None of these are Chorus account/admin settings — they're all local to this server.
- `CHORUS_BASE_URL` (default `https://chorus.ai/v3`)
- `CHORUS_MAX_PAGES` (default `40`) — pages fetched in a single sync call. Keep this small; it's
  what keeps any one tool call fast and safely under an MCP client's request timeout. Don't raise
  this to reach further history — see `CHORUS_MAX_HISTORY_PAGES` below for that.
- `CHORUS_PAGE_PARAM` (default `continuation_key`) — the next-page query param name.
- `CHORUS_PAGE_DELAY_MS` (default `120`) — delay between paged requests.
- `CHORUS_STORE_PATH` (default `~/Library/Application Support/chorusai-mcp-server/engagements.json`)
- `CHORUS_MAX_AGE_MINUTES` (default `60`) — how stale the store may get before auto-syncing.
- `CHORUS_MAX_HISTORY_PAGES` (default `150`) — total historical depth target, reached gradually
  across several `CHORUS_MAX_PAGES`-sized calls rather than one slow one (see Persistence above).
  At typical volumes 150 pages covers well over a year, but if a long-tenured named account's
  earliest (discovery-call) evidence still looks thin after `backfill_complete` is `true`, raise
  this — that conversation is the oldest, so it's the first thing that falls outside any cap.

## Testing
- `npm test` — unit tests for the pure matching/grouping logic in `lib.js`, run against a real
  saved page of `/v3/engagements` (`tests/fixtures/engagements-page1.json`, pulled live and
  read-only — regenerate with `node tests/fetch-fixture.mjs`).
- `npm run test:live` — full live integration test: spawns the real server over stdio and drives
  every tool via JSON-RPC against the live Chorus API, including cold-start, warm-cache,
  simulated-restart, `force_refresh`, and `max_age_minutes` behavior. Reads your API token from
  the Claude Desktop config for the duration of the test only; never logs or writes it anywhere.

## Privacy note
You only see recordings your Chorus user has data-access to, and private-marked recordings are
excluded by Chorus. If an account looks empty, it may be owned by reps outside your visibility.
The local store only ever holds data your token can already see, and the API key itself is never
written into it.
