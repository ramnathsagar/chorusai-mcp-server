// lib.test.mjs — unit tests for the pure matching/grouping logic in lib.js, using synthetic data.

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
const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "engagements-synthetic.json"), "utf8"));
const engagements = fixture.engagements;

test("normalizeName strips legal suffixes and punctuation", () => {
  assert.equal(normalizeName("Acme Robotics, Inc."), "acmerobotics");
  assert.equal(normalizeName("Example Systems LLC"), "examplesystems");
  assert.equal(normalizeName("Acme Corp."), "acme");
  assert.equal(normalizeName(""), "");
  assert.equal(normalizeName(null), "");
});

test("isDomain distinguishes domains from display names", () => {
  assert.equal(isDomain("acme.example"), true);
  assert.equal(isDomain("acme.co.uk"), true);
  assert.equal(isDomain("Acme Robotics"), false);
  assert.equal(isDomain("Example Systems"), false);
});

test("domainRoot extracts the meaningful label", () => {
  assert.equal(domainRoot("acme.example"), "acme");
  assert.equal(domainRoot("foo.bimba.ai"), "bimba");
  assert.equal(domainRoot(""), "");
});

test("toISO tolerates epoch seconds, ms, and bad input", () => {
  assert.equal(toISO(1700000000), new Date(1700000000 * 1000).toISOString());
  assert.equal(toISO(1700000000000), new Date(1700000000000).toISOString());
  assert.equal(toISO(null), null);
  assert.equal(toISO("not-a-date"), null);
});

test("matchEngagement matches an account by exact display name", () => {
  const e = engagements.find((x) => x.account_name === "Acme Robotics");
  assert.ok(e, "fixture must contain an Acme Robotics engagement");
  assert.equal(matchEngagement(e, ["Acme Robotics"]), "Acme Robotics");
});

test("matchEngagement fuzzy-matches company name variants", () => {
  const e = engagements.find((x) => (x.participants || []).some((p) => p.company_name === "Acme Robotics, Inc."));
  assert.ok(e, "fixture must contain a participant from Acme Robotics, Inc.");
  assert.equal(matchEngagement(e, ["Acme Robotics"]), "Acme Robotics");
});

test("matchEngagement matches by prospect email domain", () => {
  const e = engagements.find((x) => (x.participants || []).some((p) => p.type === "prospect" && p.email?.endsWith("@acme.example")));
  assert.ok(e, "fixture must contain an acme.example prospect");
  assert.equal(matchEngagement(e, ["acme.example"]), "acme.example");
});

test("matchEngagement ignores rep-side company/domain (our own reps never self-match)", () => {
  const e = engagements.find((x) => (x.participants || []).some((p) => p.type === "rep" && p.company_name === "SellerCo"));
  assert.ok(e, "fixture must contain a SellerCo rep participant");
  // Querying our own rep's company/domain must NOT match, or every call would match every account.
  assert.equal(matchEngagement(e, ["SellerCo"]), null);
  assert.equal(matchEngagement(e, ["seller.example"]), null);
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
  const groups = groupByAccount(engagements, ["Acme Robotics"], "index");
  assert.ok(groups.length >= 1);
  const acmeGroup = groups.find((g) => g.matched_as === "Acme Robotics");
  assert.ok(acmeGroup);
  assert.ok(acmeGroup.engagements.length >= 2, "fixture has multiple Acme engagements");
  const dates = acmeGroup.engagements.map((e) => e.date).filter(Boolean);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, "engagements must be sorted chronologically");
});

test("groupByAccount 'detail' mode includes meeting_summary/action_items", () => {
  const groups = groupByAccount(engagements, ["Acme Robotics"], "detail");
  const acmeGroup = groups.find((g) => g.matched_as === "Acme Robotics");
  assert.ok(acmeGroup);
  const withSummary = acmeGroup.engagements.find((e) => e.meeting_summary);
  if (withSummary) {
    assert.equal(typeof withSummary.meeting_summary, "string");
    assert.ok(Array.isArray(withSummary.action_items));
  }
});

test("groupByAccount excludes unmatched accounts entirely", () => {
  const groups = groupByAccount(engagements, ["Totally Fictional Company 12345"], "index");
  assert.equal(groups.length, 0);
});
