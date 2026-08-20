// lib.test.mjs — unit tests for the pure matching/grouping logic in lib.js, run against a real
// saved page of /v3/engagements (tests/fixtures/engagements-page1.json, pulled live, read-only —
// see tests/fetch-fixture.mjs). No hand-written fake data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  normalizeName,
  isDomain,
  domainRoot,
  toISO,
  matchEngagement,
  isRecorded,
  groupByAccount,
} from "../lib.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "engagements-page1.json"), "utf8"));
const engagements = fixture.engagements;

test("normalizeName strips legal suffixes and punctuation", () => {
  assert.equal(normalizeName("Atlassian, Inc."), "atlassian");
  assert.equal(normalizeName("John Wiley & Sons Inc"), "johnwileysons");
  assert.equal(normalizeName("Acme Corp."), "acme");
  assert.equal(normalizeName(""), "");
  assert.equal(normalizeName(null), "");
});

test("isDomain distinguishes domains from display names", () => {
  assert.equal(isDomain("wiley.com"), true);
  assert.equal(isDomain("acme.co.uk"), true);
  assert.equal(isDomain("Atlassian"), false);
  assert.equal(isDomain("John Wiley & Sons"), false);
});

test("domainRoot extracts the meaningful label", () => {
  assert.equal(domainRoot("wiley.com"), "wiley");
  assert.equal(domainRoot("foo.bimba.ai"), "bimba");
  assert.equal(domainRoot(""), "");
});

test("toISO tolerates epoch seconds, ms, and bad input", () => {
  assert.equal(toISO(1700000000), new Date(1700000000 * 1000).toISOString());
  assert.equal(toISO(1700000000000), new Date(1700000000000).toISOString());
  assert.equal(toISO(null), null);
  assert.equal(toISO("not-a-date"), null);
});

test("matchEngagement matches a real account by exact display name", () => {
  const e = engagements.find((x) => x.account_name === "Wiley");
  assert.ok(e, "fixture must contain a Wiley engagement");
  assert.equal(matchEngagement(e, ["Wiley"]), "Wiley");
});

test("matchEngagement fuzzy-matches company name variants (e.g. 'Wiley' vs 'John Wiley & Sons Inc')", () => {
  const e = engagements.find((x) => (x.participants || []).some((p) => p.company_name === "John Wiley & Sons Inc"));
  assert.ok(e, "fixture must contain a participant from John Wiley & Sons Inc");
  assert.equal(matchEngagement(e, ["Wiley"]), "Wiley");
});

test("matchEngagement matches by prospect email domain", () => {
  const e = engagements.find((x) => (x.participants || []).some((p) => p.type === "prospect" && p.email?.endsWith("@wiley.com")));
  assert.ok(e, "fixture must contain a wiley.com prospect");
  assert.equal(matchEngagement(e, ["wiley.com"]), "wiley.com");
});

test("matchEngagement ignores rep-side company/domain (our own reps never self-match)", () => {
  const e = engagements.find((x) => (x.participants || []).some((p) => p.type === "rep" && p.company_name === "PingCap"));
  assert.ok(e, "fixture must contain a PingCap rep participant");
  // Querying our own rep's company/domain must NOT match, or every call would match every account.
  assert.equal(matchEngagement(e, ["PingCap"]), null);
  assert.equal(matchEngagement(e, ["pingcap.com"]), null);
});

test("matchEngagement returns null for accounts not present", () => {
  const e = engagements[0];
  assert.equal(matchEngagement(e, ["Definitely Not A Real Customer Name Xyz"]), null);
});

test("isRecorded requires a done, positive-duration meeting with no no_show", () => {
  const recordedMeeting = engagements.find((e) => e.engagement_type === "meeting" && e.processing_state === "done" && Number(e.duration) > 0 && !e.no_show);
  if (recordedMeeting) assert.equal(isRecorded(recordedMeeting), true);
  const email = engagements.find((e) => e.engagement_type === "email");
  if (email) assert.equal(isRecorded(email), false);
});

test("groupByAccount groups multiple engagements under one bucket, sorted chronologically", () => {
  const groups = groupByAccount(engagements, ["Wiley"], "index");
  assert.ok(groups.length >= 1);
  const wileyGroup = groups.find((g) => g.matched_as === "Wiley");
  assert.ok(wileyGroup);
  assert.ok(wileyGroup.engagements.length >= 2, "fixture has multiple Wiley engagements");
  const dates = wileyGroup.engagements.map((e) => e.date).filter(Boolean);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, "engagements must be sorted chronologically");
});

test("groupByAccount 'detail' mode includes meeting_summary/action_items", () => {
  const groups = groupByAccount(engagements, ["Wiley"], "detail");
  const wileyGroup = groups.find((g) => g.matched_as === "Wiley");
  assert.ok(wileyGroup);
  const withSummary = wileyGroup.engagements.find((e) => e.meeting_summary);
  if (withSummary) {
    assert.equal(typeof withSummary.meeting_summary, "string");
    assert.ok(Array.isArray(withSummary.action_items));
  }
});

test("groupByAccount excludes unmatched accounts entirely", () => {
  const groups = groupByAccount(engagements, ["Totally Fictional Company 12345"], "index");
  assert.equal(groups.length, 0);
});
