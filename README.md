# chorusai-mcp-server (v1.3)

A local, read-only MCP server for account-centric ZoomInfo Chorus data. It combines two different
evidence layers without treating them as interchangeable:

1. Chorus AI summaries across many engagements for recurring themes and frequency.
2. Selected verbatim transcripts for exact voice-of-customer wording, context, objections,
   alternatives, triggers, desired outcomes, and perceived value.

Version 1.3 adds bounded transcript retrieval while preserving every v1.2 tool and input schema.
It deliberately does not add an external model dependency or claim that deterministic code can
reliably infer positioning evidence from language.

## Read-only API contract

The server makes GET requests only:

- `GET https://chorus.ai/v3/engagements` for paginated engagement metadata, summaries, action
  items, participants, metrics, account, and opportunity fields.
- `GET https://chorus.ai/v3/engagements?engagement_id=<id,...>` for selected engagement metadata.
- `GET https://chorus.ai/api/v1/conversations/:id?fields=...recording.utterances` for a selected
  verbatim transcript.

Authentication is the Chorus personal API token sent directly in the `Authorization` header. It
is not prefixed with `Bearer`, logged, or persisted.

The transcript contract was established from the current official
[Chorus API documentation](https://api-docs.chorus.ai/) and its published Postman collection,
then verified live against this tenant on 2026-08-19:

- A v3 `engagement_id` works directly as the v1 conversation `:id`.
- The response is JSON:API: `data.attributes.recording.utterances`.
- Each observed utterance includes `id`, `index`, `date_time`, `snippet_time`, `snippet_length`,
  `participant`, `speaker_id`, `speaker_name`, `speaker_type`, and verbatim `snippet`.
- `date_time` is an absolute ISO-8601 timestamp. `snippet_time` and `snippet_length` are seconds
  relative to the recording.
- Observed utterance speaker types were `customer` and `rep`. Participant metadata also exposes
  `type`, `is_my_team`, `person_id`, name, title, company, and email.
- Live 200, 401, and 404 behavior was verified without printing transcript content.

The official docs state that private recordings are omitted and the API token user's data-access
controls apply. Consequently, a 404 cannot reliably distinguish an absent transcript from a
private or otherwise inaccessible recording. Numeric transcript rate limits are not documented,
and the verified responses exposed no rate-limit headers. The client still honors `Retry-After`
or rate-reset headers and retries a 429 once.

## Setup

Requires Node.js 18 or newer.

```bash
cd /path/to/chorusai-mcp-server
./setup.sh
```

Add the resulting command and path to your MCP client configuration:

```json
{
  "mcpServers": {
    "chorusai-mcp-server": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/chorusai-mcp-server/index.js"],
      "env": {
        "CHORUS_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Use the full path returned by `which node`; desktop applications often have a minimal `PATH`.

## MCP tools

- `chorus_health` — live authentication/connectivity and engagement-store status.
- `diagnose_filters` — verifies supported v3 engagement filters against the tenant.
- `find_account_conversations` — compact account-matched engagement index.
- `get_account_brief` — summaries, action items, participants, opportunity, and metrics.
- `get_engagement_detail` — full distilled metadata for selected engagement IDs.
- `get_transcript` — bounded verbatim transcript segments for selected recorded meetings.

Existing v1.2 tool names and input schemas remain unchanged.

### `get_transcript`

Input:

```json
{
  "engagement_ids": ["SYNTH-ENG-001"],
  "customer_speakers_only": true,
  "include_internal_speakers": true,
  "include_timestamps": true,
  "segment_cursor": 0,
  "max_segments_per_engagement": 100,
  "max_characters_per_engagement": 30000
}
```

Behavior:

- Accepts 1–10 engagement IDs and returns one result per ID.
- Returns partial success when another requested ID fails.
- Sorts utterances by Chorus index, then relative/absolute time as fallbacks.
- Classifies speakers as `customer`, `internal`, or `unknown`, and states the classification basis.
- `customer_speakers_only=true` excludes internal and ambiguous speakers.
- `include_internal_speakers=false` excludes internal speakers but preserves ambiguous speakers.
- Every segment includes `engagement_id`, `segment_ref`, source utterance ID/index, speaker
  attribution, `text_kind: "verbatim_transcript"`, and `verbatim_text`.
- Timestamps include absolute ISO start/end plus relative start/end/duration seconds when enabled.
- The result includes account, opportunity, meeting date, subject, language, processing status,
  and Chorus application URL when available from source data.
- Deal stage or outcome is not inferred when Chorus does not provide it.

The official endpoint returns its utterance array in one response and documents no transcript
pagination. To keep MCP responses bounded, pagination is applied locally after retrieval:

- `segment_cursor` is a zero-based cursor into the transcript after speaker filtering.
- `max_segments_per_engagement` defaults to 100 and is capped at 250.
- `max_characters_per_engagement` defaults to 30,000 and is capped at 100,000.
- `next_segment_cursor` is returned when more matching segments remain.
- Character limits stop at segment boundaries. If the first segment alone exceeds the budget, a
  marked verbatim prefix is returned with `text_truncated: true`.

`force_refresh` is unnecessary because transcripts are not cached.

### Transcript availability and errors

Each engagement result has an `availability` value rather than causing the whole batch to fail:

| Availability | Meaning |
|---|---|
| `available` | Verbatim segments were returned. |
| `processing` | Engagement metadata or the API indicates processing is incomplete. |
| `not_recorded` | Non-meeting, no-show, zero-duration, or otherwise unrecorded engagement. |
| `empty_transcript` | A completed recording returned an empty utterance list. |
| `private` | Chorus explicitly marked the returned recording private; content is suppressed. |
| `not_found_or_inaccessible` | HTTP 404; absent, private, or outside the token user's access. |
| `authentication_failed` | HTTP 401. |
| `permission_denied` | HTTP 403. |
| `rate_limited` | HTTP 429 remained after one retry. |
| `malformed_response` | HTTP 200 with an unexpected response schema. |
| `network_error` / `upstream_error` | Transport failure or Chorus 5xx response. |

Upstream response bodies are never copied into transcript errors, which prevents accidental
transcript or privacy-error content from reaching logs.

## Positioning workflow

Use summaries first to discover patterns across many calls. They are useful for frequency and
theme discovery, but they are Chorus-generated paraphrases—not customer quotations.

Then select the most relevant recorded engagements and use `get_transcript` for exact wording.
The MCP remains deterministic, so evidence interpretation should happen downstream. A suitable
prompt is:

```text
Analyze only segments whose speaker.classification is customer unless explicitly asked otherwise.
For each supported item, choose one evidence_type from pain, desired_outcome, buying_trigger,
competitive_alternative, objection, differentiated_value, selection_reason,
implementation_concern, or measurable_outcome.

Return:
- evidence_type
- verbatim_excerpt copied exactly from verbatim_text
- paraphrased_interpretation without quotation marks
- speaker name, role, and classification
- engagement_id, segment_ref, and timestamp
- account and opportunity only when present
- confidence and brief supporting context

Never call a paraphrase the customer's exact words. Never put paraphrased text in quotation
marks. Never infer deal stage or outcome when absent. Every verbatim excerpt must cite one or more
source segments and must not combine non-contiguous words into a fabricated quotation.
```

This supports the evidence sequence in April Dunford's *Obviously Awesome*: use cross-meeting
summaries to identify candidate patterns, then use selected customer transcript segments to test
competitive alternatives, differentiated capabilities, customer value, best-fit characteristics,
and market-category hypotheses in the customer's own language.

## Persistence and privacy

The existing engagement-summary store remains unchanged:

- Default path: `~/Library/Application Support/chorusai-mcp-server/engagements.json`
- Override: `CHORUS_STORE_PATH`
- Atomic JSON writes, historical backfill, incremental refresh, and freshness controls behave as
  in v1.2.

Transcripts are separate by design: **they are never persisted or cached**. They exist only in
memory for the duration of a tool call and in the MCP response returned to the requesting client.
There is no transcript cache to clear and no transcript retention setting. The engagement store
may still contain Chorus summaries and participant metadata, so protect it as customer data.

Never commit or upload API keys, desktop client configuration, the engagement store, fetched live
fixtures, transcripts, logs, archives, or `node_modules`. The repository `.gitignore` excludes the
known local forms of these artifacts. Committed tests use synthetic fixtures only.

## Configuration

Required:

- `CHORUS_API_KEY`

Optional:

- `CHORUS_BASE_URL` — default `https://chorus.ai/v3`
- `CHORUS_TRANSCRIPT_BASE_URL` — default `https://chorus.ai/api/v1`
- `CHORUS_PAGE_PARAM` — default `continuation_key`
- `CHORUS_PAGE_DELAY_MS` — default `120`
- `CHORUS_MAX_PAGES` — default `40`, per sync call
- `CHORUS_STORE_PATH` — engagement metadata/summary store path
- `CHORUS_MAX_AGE_MINUTES` — default `60`
- `CHORUS_MAX_HISTORY_PAGES` — default `150`, gradually backfilled across calls

`CHORUS_TRANSCRIPT_BASE_URL` is intended for a verified tenant proxy or test server. Changing it
does not change the expected v1 JSON:API contract.

## Testing

```bash
npm test
npm run test:live
```

`npm test` uses only synthetic fixtures and includes:

- Existing account matching/grouping regression tests.
- Transcript ordering, timestamps, speaker classification, filters, ambiguity, processing,
  no-recording, private, auth/permission/not-found/rate-limit errors, malformed responses,
  output limits, partial success, provenance, and verbatim/paraphrase separation.
- A localhost JSON-RPC MCP test covering `tools/list`, `get_transcript`, an existing detail tool,
  GET-only behavior, bounded output, partial success, and transcript non-persistence.

`npm run test:live` uses the locally configured token, selects an accessible account at runtime,
and never prints transcript text, speaker names, engagement IDs, summaries, or raw responses. It
checks transcript structure, counts, customer classification, provenance, partial 404 behavior,
and verifies that returned transcript text is absent from the isolated engagement store before
deleting that store.

Verified live on 2026-08-19: endpoint access, v3-to-v1 ID mapping, JSON:API/utterance schema,
speaker types, timestamp units, successful transcript retrieval, 401, 404, and lack of exposed
rate-limit headers. Verified with synthetic mocks only: 403, explicit private response, v1
still-processing response, persistent 429/retry behavior, malformed payloads, and server 5xx.
