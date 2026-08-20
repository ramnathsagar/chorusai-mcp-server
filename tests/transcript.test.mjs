import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  classifyTranscriptHttpError,
  fetchTranscriptBatch,
  normalizeTranscriptResponse,
  unavailableFromMetadata,
} from "../transcript.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures", "transcript-conversation-synthetic.json"), "utf8"));
const engagement = {
  engagement_id: "SYNTH-ENG-001",
  engagement_type: "meeting",
  processing_state: "done",
  date_time: 1704103200,
  duration: 1800,
  no_show: false,
  subject: "Synthetic discovery call",
  account_id: "SYNTH-ACCOUNT-1",
  account_name: "Acme Robotics",
  opportunity_id: "SYNTH-DEAL-1",
  opportunity_name: "Acme Evaluation",
  language: "en",
  url: "https://chorus.example.local/recording/SYNTH-ENG-001",
};

const normalize = (options = {}, body = fixture) => normalizeTranscriptResponse(
  engagement.engagement_id,
  engagement,
  structuredClone(body),
  options,
);

test("successful transcript retrieval preserves provenance and orders segments", () => {
  const result = normalize();
  assert.equal(result.availability, "available");
  assert.equal(result.meeting_date, "2024-01-01T10:00:00.000Z");
  assert.deepEqual(result.segments.map((s) => s.source_index), [0, 1, 2, 3]);
  assert.ok(result.segments.every((s) => s.engagement_id === engagement.engagement_id));
  assert.ok(result.segments.every((s) => s.segment_ref && s.text_kind === "verbatim_transcript"));
  assert.ok(result.segments.every((s) => typeof s.verbatim_text === "string"));
  assert.ok(result.segments.every((s) => !("paraphrased_interpretation" in s)));
});

test("timestamps normalize to ISO plus relative seconds", () => {
  const [first] = normalize().segments;
  assert.equal(first.timestamps.absolute_start, "2024-01-01T10:00:01.000Z");
  assert.equal(first.timestamps.absolute_end, "2024-01-01T10:00:06.000Z");
  assert.equal(first.timestamps.start_seconds, 1);
  assert.equal(first.timestamps.end_seconds, 6);
  assert.equal(first.timestamps.duration_seconds, 5);
});

test("include_timestamps=false omits timestamp objects", () => {
  const result = normalize({ includeTimestamps: false });
  assert.ok(result.segments.every((s) => !("timestamps" in s)));
});

test("speaker classification distinguishes customer, internal, and unknown", () => {
  const result = normalize();
  assert.deepEqual(result.segments.map((s) => s.speaker.classification), ["customer", "customer", "internal", "unknown"]);
  assert.equal(result.segments[1].speaker.classification_basis, "participant.type");
  assert.equal(result.segments[3].speaker.classification_basis, "insufficient_metadata");
});

test("customer_speakers_only returns only confidently customer-side speech", () => {
  const result = normalize({ customerSpeakersOnly: true });
  assert.deepEqual(result.segments.map((s) => s.source_index), [0, 1]);
  assert.ok(result.segments.every((s) => s.speaker.classification === "customer"));
});

test("include_internal_speakers=false preserves unknown speakers", () => {
  const result = normalize({ includeInternalSpeakers: false });
  assert.deepEqual(result.segments.map((s) => s.speaker.classification), ["customer", "customer", "unknown"]);
});

test("missing speaker fields remain explicit and ambiguous", () => {
  const body = structuredClone(fixture);
  const u = body.data.attributes.recording.utterances[0];
  delete u.speaker_id;
  delete u.participant;
  delete u.speaker_name;
  delete u.speaker_type;
  const result = normalize({}, body);
  const segment = result.segments.find((s) => s.source_utterance_id === "SYNTH-UTT-3");
  assert.equal(segment.speaker.name, null);
  assert.equal(segment.speaker.classification, "unknown");
});

test("is_my_team=false alone does not over-classify an unknown participant as a customer", () => {
  const body = structuredClone(fixture);
  const unknownParticipant = body.data.attributes.participants.find((p) => p.person_id === 303);
  unknownParticipant.is_my_team = false;
  const result = normalize({}, body);
  const segment = result.segments.find((s) => s.source_utterance_id === "SYNTH-UTT-4");
  assert.equal(segment.speaker.classification, "unknown");
  assert.equal(segment.speaker.classification_basis, "insufficient_metadata");
});

test("metadata identifies processing, no-show, and non-recorded engagements without a transcript call", () => {
  assert.equal(unavailableFromMetadata("A", { ...engagement, processing_state: "processing" }).availability, "processing");
  assert.equal(unavailableFromMetadata("B", { ...engagement, processing_state: "no show", no_show: true }).availability, "not_recorded");
  assert.equal(unavailableFromMetadata("C", { ...engagement, engagement_type: "email", duration: 0 }).availability, "not_recorded");
});

test("empty, private, and malformed transcript responses are explicit", () => {
  const empty = structuredClone(fixture);
  empty.data.attributes.recording.utterances = [];
  assert.equal(normalize({}, empty).availability, "empty_transcript");
  const processing = structuredClone(empty);
  processing.data.attributes.status = "processing";
  assert.equal(normalize({}, processing).availability, "processing");
  const privateBody = structuredClone(fixture);
  privateBody.data.attributes.private = true;
  assert.equal(normalize({}, privateBody).availability, "private");
  assert.equal(normalize({}, { unexpected: true }).availability, "malformed_response");
});

test("HTTP authentication, permission, not-found, rate-limit, and upstream errors are sanitized", () => {
  const cases = [[401, "authentication_failed"], [403, "permission_denied"], [404, "not_found_or_inaccessible"], [429, "rate_limited"], [503, "upstream_error"]];
  for (const [status, availability] of cases) {
    const result = classifyTranscriptHttpError(engagement.engagement_id, engagement, { status, body: { errors: [{ detail: "sensitive upstream body" }] } });
    assert.equal(result.availability, availability);
    assert.doesNotMatch(JSON.stringify(result), /sensitive upstream body/);
  }
});

test("segment and character controls return stable continuation cursors", () => {
  const paged = normalize({ maxSegments: 2 });
  assert.equal(paged.segments.length, 2);
  assert.equal(paged.next_segment_cursor, 2);
  assert.equal(paged.truncated.segment_limit, true);
  const page2 = normalize({ segmentCursor: 2, maxSegments: 2 });
  assert.deepEqual(page2.segments.map((s) => s.source_index), [2, 3]);
  assert.equal(page2.next_segment_cursor, null);

  const body = structuredClone(fixture);
  body.data.attributes.recording.utterances[1].snippet = "x".repeat(2_000);
  const chars = normalize({ maxCharacters: 1_000 }, body);
  assert.equal(chars.segments.length, 1);
  assert.equal(chars.segments[0].verbatim_text.length, 1_000);
  assert.equal(chars.segments[0].text_truncated, true);
  assert.equal(chars.truncated.character_limit, true);
});

test("multiple engagement IDs return partial success", async () => {
  const ids = ["SYNTH-ENG-001", "SYNTH-ENG-403", "SYNTH-ENG-404"];
  const metadata = new Map([["SYNTH-ENG-001", engagement]]);
  const { transcripts } = await fetchTranscriptBatch(ids, metadata, {}, async (id) => {
    if (id === "SYNTH-ENG-001") return { status: 200, body: structuredClone(fixture), rate: null };
    if (id === "SYNTH-ENG-403") return { status: 403, body: { errors: [] }, rate: null };
    return { status: 404, body: { errors: [] }, rate: null };
  });
  assert.deepEqual(transcripts.map((t) => t.availability), ["available", "permission_denied", "not_found_or_inaccessible"]);
});

test("network failures are per-engagement and never expose thrown content", async () => {
  const { transcripts } = await fetchTranscriptBatch(["SYNTH-ENG-ERR"], new Map(), {}, async () => {
    throw new Error("synthetic transcript phrase that must not leak");
  });
  assert.equal(transcripts[0].availability, "network_error");
  assert.doesNotMatch(JSON.stringify(transcripts[0]), /must not leak/);
});

test("malformed individual utterances are ignored and counted", () => {
  const body = structuredClone(fixture);
  body.data.attributes.recording.utterances.push({ index: 99, snippet: null });
  const result = normalize({}, body);
  assert.equal(result.segment_counts.malformed_ignored, 1);
  assert.equal(result.segments.length, 4);
});

test("normalization never writes transcript text to console", () => {
  const originalLog = console.log;
  const originalError = console.error;
  const seen = [];
  console.log = (...args) => seen.push(args);
  console.error = (...args) => seen.push(args);
  try { normalize(); } finally { console.log = originalLog; console.error = originalError; }
  assert.equal(seen.length, 0);
});
