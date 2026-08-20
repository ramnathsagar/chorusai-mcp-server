import { test } from "node:test";
import assert from "node:assert/strict";

process.env.CHORUS_API_KEY = "synthetic-test-key";
const { apiGetRawAt } = await import("../chorus-client.js");

test("GET client retries 429 once and preserves authorization format", async () => {
  let calls = 0;
  const waits = [];
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "synthetic-test-key");
    assert.equal(new URL(url).pathname, "/api/v1/conversations/SYNTH-ENG-001");
    if (calls === 1) return new Response(JSON.stringify({ errors: [] }), { status: 429, headers: { "retry-after": "1" } });
    return new Response(JSON.stringify({ data: { attributes: { recording: { utterances: [] } } } }), { status: 200 });
  };
  const result = await apiGetRawAt(
    "https://chorus.example.local/api/v1",
    "conversations/SYNTH-ENG-001",
    { fields: "recording.utterances" },
    { fetchImpl, sleepFn: async (ms) => waits.push(ms), captureNonJson: false },
  );
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1000]);
});

test("transcript-safe non-JSON handling never retains response text", async () => {
  const result = await apiGetRawAt(
    "https://chorus.example.local/api/v1",
    "conversations/SYNTH-ENG-001",
    {},
    { fetchImpl: async () => new Response("synthetic secret transcript body", { status: 502 }), captureNonJson: false },
  );
  assert.deepEqual(result.body, { _nonjson: true });
  assert.doesNotMatch(JSON.stringify(result), /secret transcript body/);
});
