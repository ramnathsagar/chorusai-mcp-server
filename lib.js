// lib.js — pure helpers for the Chorus ICP MCP server.
// No network here, so this file is unit-testable against a saved /v3/engagements payload.

/** Normalize a company string for fuzzy matching: lowercase, strip legal suffixes & punctuation. */
export function normalizeName(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/\b(inc|inc\.|llc|ltd|ltd\.|corp|corporation|co|company|gmbh|plc|sa|ag|pvt|private|limited)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

/** Is a requested token a domain (e.g. "acme.com", "bimba.ai") rather than a display name? */
export function isDomain(token) {
  const t = String(token || "").trim().toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(t) && !t.includes(" ");
}

/** Root label of a domain, e.g. "acme.com" -> "acme", "foo.bimba.ai" -> "bimba". */
export function domainRoot(domain) {
  const parts = String(domain || "").toLowerCase().split(".").filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || "";
}

/** Convert Chorus date_time (epoch seconds or ms) to an ISO date string; tolerate bad input. */
export function toISO(dt) {
  if (dt == null) return null;
  let n = Number(dt);
  if (!isFinite(n)) return null;
  if (n < 1e12) n = n * 1000; // seconds -> ms
  const d = new Date(n);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Decide whether an engagement belongs to one of the requested accounts.
 * Requested entries may be display names ("Acme Robotics") or domains ("acme.example").
 * Returns the matched requested-token (original casing) or null.
 */
export function matchEngagement(engagement, requested) {
  const acctNorm = normalizeName(engagement.account_name);
  const participants = Array.isArray(engagement.participants) ? engagement.participants : [];
  // Only the customer side counts for domain/company matching. Chorus marks the
  // seller's own attendees as type "rep"; prospects/customers are everything else.
  // Without this, querying your own domain (e.g. the rep on every call) matches everything.
  const external = participants.filter((p) => p && p.type !== "rep");
  const partCompanies = external.map((p) => normalizeName(p.company_name)).filter(Boolean);
  const partDomains = external
    .map((p) => (p.email && p.email.includes("@") ? p.email.split("@")[1].toLowerCase() : null))
    .filter(Boolean);

  for (const req of requested) {
    const raw = String(req).trim();
    if (!raw) continue;

    if (isDomain(raw)) {
      const root = domainRoot(raw);
      // match by participant email domain (exact or subdomain) ...
      if (partDomains.some((d) => d === raw.toLowerCase() || d.endsWith("." + raw.toLowerCase()))) return raw;
      // ... or by the domain's root label against account/participant company names
      if (root.length >= 3) {
        if (acctNorm.includes(root)) return raw;
        if (partCompanies.some((c) => c.includes(root))) return raw;
      }
    } else {
      const reqNorm = normalizeName(raw);
      if (reqNorm.length < 2) continue;
      const hit =
        (acctNorm && (acctNorm.includes(reqNorm) || reqNorm.includes(acctNorm))) ||
        partCompanies.some((c) => c && (c.includes(reqNorm) || reqNorm.includes(c)));
      if (hit) return raw;
    }
  }
  return null;
}

/** True if this engagement is a recorded meeting that could carry a transcript (v2). */
export function isRecorded(e) {
  return e.engagement_type === "meeting" && e.processing_state === "done" && Number(e.duration) > 0 && !e.no_show;
}

/** Compact index row for an engagement (metadata only; cheap to scan). */
export function indexRow(e) {
  const participants = Array.isArray(e.participants) ? e.participants : [];
  return {
    engagement_id: e.engagement_id,
    date: toISO(e.date_time),
    type: e.engagement_type,
    processing_state: e.processing_state,
    recorded: isRecorded(e),
    subject: e.subject || null,
    account_name: e.account_name || null,
    opportunity_name: e.opportunity_name || null,
    duration_min: e.duration ? Math.round((Number(e.duration) / 60) * 10) / 10 : null,
    participant_count: participants.length,
    has_summary: Boolean(e.meeting_summary && String(e.meeting_summary).trim()),
    has_action_items: Array.isArray(e.action_items) && e.action_items.length > 0,
  };
}

/** Full detail row incl. the distilled AI content we DO have on /v3 (summary, action items, people, topics). */
export function detailRow(e) {
  const participants = (Array.isArray(e.participants) ? e.participants : []).map((p) => ({
    name: p.name || null,
    title: p.title || null,
    company: p.company_name || null,
    email: p.email || null,
    side: p.type || null, // internal vs external, per Chorus
  }));
  return {
    engagement_id: e.engagement_id,
    date: toISO(e.date_time),
    type: e.engagement_type,
    processing_state: e.processing_state,
    recorded: isRecorded(e),
    subject: e.subject || null,
    account_name: e.account_name || null,
    opportunity_name: e.opportunity_name || null,
    opportunity_id: e.opportunity_id || null,
    duration_min: e.duration ? Math.round((Number(e.duration) / 60) * 10) / 10 : null,
    language: e.language || null,
    meeting_summary: e.meeting_summary || null,
    action_items: Array.isArray(e.action_items) ? e.action_items : [],
    num_customer_questions: e.num_cust_questions ?? null,
    num_engaging_questions: e.num_engaging_questions ?? null,
    participants,
    app_url: e.url || null,
  };
}

/**
 * Group a flat engagement list into { account -> {matched_as, engagements:[...]} } for requested accounts.
 * `mode` = "index" (compact rows) or "detail" (full rows with summaries).
 */
export function groupByAccount(engagements, requested, mode = "index") {
  const rowFn = mode === "detail" ? detailRow : indexRow;
  const groups = new Map(); // key: displayed account bucket
  for (const e of engagements) {
    const matchedReq = matchEngagement(e, requested);
    if (!matchedReq) continue;
    const bucket = e.account_name || matchedReq;
    if (!groups.has(bucket)) groups.set(bucket, { account: bucket, matched_as: matchedReq, engagements: [] });
    groups.get(bucket).engagements.push(rowFn(e));
  }
  // sort each account's engagements chronologically (stage progression)
  for (const g of groups.values()) {
    g.engagements.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    g.counts = {
      total: g.engagements.length,
      recorded_meetings: g.engagements.filter((x) => x.recorded).length,
      with_summary: g.engagements.filter((x) => x.has_summary ?? x.meeting_summary).length,
    };
  }
  return Array.from(groups.values());
}
