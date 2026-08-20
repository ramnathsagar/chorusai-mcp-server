// transcript.js — deterministic, privacy-conscious transcript normalization for Chorus.
// No transcript is logged or persisted here. Every returned verbatim segment carries source
// provenance; interpretation/extraction is intentionally left to the MCP client.

export const DEFAULT_MAX_SEGMENTS = 100;
export const MAX_SEGMENTS = 250;
export const DEFAULT_MAX_CHARACTERS = 30_000;
export const MAX_CHARACTERS = 100_000;
export const MAX_TRANSCRIPT_IDS = 10;

const asFinite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const asIso = (value) => {
  if (value == null || value === "") return null;
  let normalized = value;
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    if (Number.isFinite(n)) normalized = n < 1e12 ? n * 1000 : n;
  }
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const addSeconds = (iso, seconds) => {
  if (!iso || seconds == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + seconds * 1000).toISOString();
};

const firstString = (...values) => {
  for (const value of values) if (typeof value === "string" && value.trim()) return value;
  return null;
};

const sameId = (left, right) => left != null && right != null && String(left) === String(right);

export function classifySpeaker(utterance, participants = []) {
  const speakerType = String(utterance?.speaker_type || "").toLowerCase();
  const speakerId = utterance?.speaker_id ?? utterance?.participant ?? null;
  const participant = participants.find((p) =>
    p && (sameId(p.person_id, speakerId) || sameId(p.person_id, utterance?.participant) || (p.name && p.name === utterance?.speaker_name)),
  ) || null;
  const participantType = String(participant?.type || "").toLowerCase();

  if (["rep", "internal", "employee"].includes(speakerType)) {
    return { classification: "internal", basis: "utterance.speaker_type", participant };
  }
  if (["customer", "prospect", "external"].includes(speakerType)) {
    return { classification: "customer", basis: "utterance.speaker_type", participant };
  }
  if (["rep", "internal", "employee"].includes(participantType)) {
    return { classification: "internal", basis: "participant.type", participant };
  }
  if (["customer", "prospect", "external"].includes(participantType)) {
    return { classification: "customer", basis: "participant.type", participant };
  }
  if (participant?.is_my_team === true) {
    return { classification: "internal", basis: "participant.is_my_team", participant };
  }
  return { classification: "unknown", basis: "insufficient_metadata", participant };
}

export function normalizeSegment(utterance, engagementId, participants, includeTimestamps = true) {
  if (!utterance || typeof utterance !== "object" || typeof utterance.snippet !== "string") return null;
  const { classification, basis, participant } = classifySpeaker(utterance, participants);
  const sourceIndex = asFinite(utterance.index);
  const relativeStart = asFinite(utterance.snippet_time);
  const duration = asFinite(utterance.snippet_length);
  const absoluteStart = asIso(utterance.date_time);
  const segmentRef = utterance.id
    ? `utterance:${utterance.id}`
    : `engagement:${engagementId}:segment:${sourceIndex ?? "unknown"}`;
  const segment = {
    engagement_id: engagementId,
    segment_ref: segmentRef,
    source_utterance_id: utterance.id || null,
    source_index: sourceIndex,
    speaker: {
      id: utterance.speaker_id ?? utterance.participant ?? participant?.person_id ?? null,
      name: firstString(utterance.speaker_name, participant?.name),
      role: firstString(participant?.title),
      chorus_speaker_type: firstString(utterance.speaker_type),
      participant_type: firstString(participant?.type),
      classification,
      classification_basis: basis,
    },
    text_kind: "verbatim_transcript",
    verbatim_text: utterance.snippet,
  };
  if (includeTimestamps) {
    segment.timestamps = {
      absolute_start: absoluteStart,
      absolute_end: addSeconds(absoluteStart, duration),
      start_seconds: relativeStart,
      end_seconds: relativeStart != null && duration != null ? relativeStart + duration : null,
      duration_seconds: duration,
    };
  }
  return segment;
}

function sortUtterances(utterances) {
  return utterances
    .map((utterance, originalIndex) => ({ utterance, originalIndex }))
    .sort((a, b) => {
      const ai = asFinite(a.utterance?.index);
      const bi = asFinite(b.utterance?.index);
      if (ai != null && bi != null && ai !== bi) return ai - bi;
      const at = asFinite(a.utterance?.snippet_time);
      const bt = asFinite(b.utterance?.snippet_time);
      if (at != null && bt != null && at !== bt) return at - bt;
      const ad = Date.parse(a.utterance?.date_time);
      const bd = Date.parse(b.utterance?.date_time);
      if (!Number.isNaN(ad) && !Number.isNaN(bd) && ad !== bd) return ad - bd;
      return a.originalIndex - b.originalIndex;
    })
    .map(({ utterance }) => utterance);
}

function metadataFields(engagement, attributes) {
  return {
    account: {
      id: engagement?.account_id ?? attributes?.account?.id ?? null,
      name: firstString(engagement?.account_name, attributes?.account?.name),
    },
    opportunity: {
      id: engagement?.opportunity_id ?? attributes?.deal?.id ?? null,
      name: firstString(engagement?.opportunity_name, attributes?.deal?.name),
    },
    meeting_date: asIso(engagement?.date_time) || asIso(attributes?.recording?.start_time),
    subject: firstString(engagement?.subject, attributes?.name),
    app_url: firstString(engagement?.url),
  };
}

function baseResult(engagementId, engagement, attributes = null) {
  return {
    engagement_id: engagementId,
    ...metadataFields(engagement, attributes),
    processing_status: firstString(attributes?.status, engagement?.processing_state),
    language: firstString(attributes?.language, engagement?.language),
    transcript_persisted: false,
  };
}

export function classifyTranscriptHttpError(engagementId, engagement, response) {
  const status = Number(response?.status) || null;
  let availability = "api_error";
  let error = "Chorus returned an unexpected response.";
  if (status === 401) { availability = "authentication_failed"; error = "Chorus authentication failed."; }
  else if (status === 403) { availability = "permission_denied"; error = "The token lacks permission to access this recording."; }
  else if (status === 404) { availability = "not_found_or_inaccessible"; error = "No accessible transcript was found; the recording may not exist, may be private, or may be outside this user's data access."; }
  else if (status === 409 || status === 425) { availability = "processing"; error = "The transcript is still processing."; }
  else if (status === 429) { availability = "rate_limited"; error = "Chorus rate-limited the transcript request after one retry."; }
  else if (status != null && status >= 500) { availability = "upstream_error"; error = "Chorus could not serve the transcript."; }
  return {
    ...baseResult(engagementId, engagement),
    availability,
    http_status: status,
    error,
    rate_limit: response?.rate || null,
    segments: [],
  };
}

export function normalizeTranscriptResponse(engagementId, engagement, body, options = {}) {
  const data = body?.data;
  const attributes = data?.attributes;
  const recording = attributes?.recording;
  if (!data || typeof data !== "object" || !attributes || typeof attributes !== "object" || !recording || typeof recording !== "object" || !Array.isArray(recording.utterances)) {
    return {
      ...baseResult(engagementId, engagement, attributes),
      availability: "malformed_response",
      http_status: 200,
      error: "Chorus returned an unexpected transcript schema.",
      segments: [],
    };
  }
  if (attributes.private === true) {
    return {
      ...baseResult(engagementId, engagement, attributes),
      availability: "private",
      http_status: 200,
      error: "Chorus marked this recording private; transcript content was not returned.",
      segments: [],
    };
  }

  const participants = Array.isArray(attributes.participants) ? attributes.participants : [];
  const ordered = sortUtterances(recording.utterances);
  const normalized = ordered
    .map((u) => normalizeSegment(u, engagementId, participants, options.includeTimestamps !== false))
    .filter(Boolean);
  const malformedSegmentCount = ordered.length - normalized.length;
  const filtered = normalized.filter((segment) => {
    if (options.customerSpeakersOnly) return segment.speaker.classification === "customer";
    if (options.includeInternalSpeakers === false) return segment.speaker.classification !== "internal";
    return true;
  });

  const cursor = Math.min(Math.max(0, Number(options.segmentCursor) || 0), filtered.length);
  const maxSegments = Math.min(MAX_SEGMENTS, Math.max(1, Number(options.maxSegments) || DEFAULT_MAX_SEGMENTS));
  const maxCharacters = Math.min(MAX_CHARACTERS, Math.max(1_000, Number(options.maxCharacters) || DEFAULT_MAX_CHARACTERS));
  const segments = [];
  let chars = 0;
  let charLimited = false;
  let consumed = 0;
  for (const segment of filtered.slice(cursor)) {
    if (segments.length >= maxSegments) break;
    const length = segment.verbatim_text.length;
    if (chars + length > maxCharacters) {
      charLimited = true;
      if (segments.length === 0) {
        segments.push({
          ...segment,
          verbatim_text: segment.verbatim_text.slice(0, maxCharacters),
          text_truncated: true,
        });
        consumed++;
      }
      break;
    }
    segments.push(segment);
    chars += length;
    consumed++;
  }
  const nextCursor = cursor + consumed < filtered.length ? cursor + consumed : null;
  const processingStatus = firstString(attributes.status, engagement?.processing_state);
  const availability = normalized.length > 0 ? "available" : processingStatus && processingStatus.toLowerCase() !== "done" ? "processing" : "empty_transcript";

  return {
    ...baseResult(engagementId, engagement, attributes),
    availability,
    http_status: 200,
    private: typeof attributes.private === "boolean" ? attributes.private : null,
    recording: {
      start_time: asIso(recording.start_time),
      duration_seconds: asFinite(recording.duration),
    },
    segment_counts: {
      source: ordered.length,
      valid: normalized.length,
      matching_filters: filtered.length,
      returned: segments.length,
      malformed_ignored: malformedSegmentCount,
    },
    segment_cursor: cursor,
    next_segment_cursor: nextCursor,
    truncated: {
      segment_limit: !charLimited && nextCursor != null && segments.length >= maxSegments,
      character_limit: charLimited,
    },
    segments,
  };
}

export function unavailableFromMetadata(engagementId, engagement) {
  if (!engagement) return null;
  const base = baseResult(engagementId, engagement);
  if (engagement.engagement_type && engagement.engagement_type !== "meeting") {
    return { ...base, availability: "not_recorded", error: "This engagement is not a meeting.", segments: [] };
  }
  const state = String(engagement.processing_state || "").toLowerCase();
  if (state && state !== "done" && state !== "completed") {
    return { ...base, availability: state.includes("no show") ? "not_recorded" : "processing", error: state.includes("no show") ? "No recording exists for this no-show meeting." : "The recording or transcript is still processing.", segments: [] };
  }
  if (engagement.no_show || Number(engagement.duration) <= 0) {
    return { ...base, availability: "not_recorded", error: "No recording is available for this meeting.", segments: [] };
  }
  return null;
}

export async function fetchTranscriptBatch(ids, metadataById, options, fetchConversation) {
  const results = [];
  let lastRate = null;
  for (const engagementId of ids) {
    const engagement = metadataById.get(engagementId) || null;
    const unavailable = unavailableFromMetadata(engagementId, engagement);
    if (unavailable) { results.push(unavailable); continue; }
    try {
      const response = await fetchConversation(engagementId);
      if (response?.rate) lastRate = response.rate;
      results.push(response?.status >= 200 && response.status < 300
        ? normalizeTranscriptResponse(engagementId, engagement, response.body, options)
        : classifyTranscriptHttpError(engagementId, engagement, response));
    } catch {
      results.push({
        ...baseResult(engagementId, engagement),
        availability: "network_error",
        error: "The transcript request failed before Chorus returned a response.",
        segments: [],
      });
    }
  }
  return { transcripts: results, rate_limit: lastRate };
}
