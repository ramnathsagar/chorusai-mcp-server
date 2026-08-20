import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");
const engagementsFixture = JSON.parse(await readFile(join(here, "fixtures", "engagements-synthetic.json"), "utf8"));
const transcriptFixture = JSON.parse(await readFile(join(here, "fixtures", "transcript-conversation-synthetic.json"), "utf8"));
const knownTranscriptText = "We spend hours reconciling the same records every Friday.";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address()));
});

const closeServer = (server) => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));

test("MCP JSON-RPC get_transcript is bounded, partial, and does not persist transcript text", async () => {
  const requests = [];
  const mock = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, fields: url.searchParams.get("fields") });
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/v3/engagements") {
      const ids = (url.searchParams.get("engagement_id") || "").split(",").filter(Boolean);
      const engagements = ids.length
        ? engagementsFixture.engagements.filter((e) => ids.includes(e.engagement_id))
        : engagementsFixture.engagements;
      res.end(JSON.stringify({ engagements, continuation_key: null }));
      return;
    }
    if (url.pathname === "/api/v1/conversations/SYNTH-ENG-001") {
      res.end(JSON.stringify(transcriptFixture));
      return;
    }
    if (url.pathname.startsWith("/api/v1/conversations/")) {
      res.statusCode = 404;
      res.end(JSON.stringify({ errors: [{ status: "404" }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ errors: [] }));
  });

  const address = await listen(mock);
  const tempDir = await mkdtemp(join(tmpdir(), "chorus-mcp-transcript-test-"));
  const storePath = join(tempDir, "engagements.json");
  let client;
  try {
    const base = `http://127.0.0.1:${address.port}`;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, "index.js")],
      env: {
        ...process.env,
        CHORUS_API_KEY: "synthetic-test-key",
        CHORUS_BASE_URL: `${base}/v3`,
        CHORUS_TRANSCRIPT_BASE_URL: `${base}/api/v1`,
        CHORUS_STORE_PATH: storePath,
        CHORUS_PAGE_DELAY_MS: "0",
      },
      stderr: "pipe",
    });
    client = new Client({ name: "synthetic-transcript-e2e", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    assert.ok(names.includes("get_transcript"));
    assert.ok(names.includes("get_account_brief"));
    assert.ok(names.includes("get_engagement_detail"));

    const response = await client.callTool({
      name: "get_transcript",
      arguments: {
        engagement_ids: ["SYNTH-ENG-001", "SYNTH-ENG-404"],
        customer_speakers_only: true,
        max_segments_per_engagement: 1,
        max_characters_per_engagement: 5_000,
      },
    });
    assert.equal(response.isError, undefined);
    const payload = JSON.parse(response.content[0].text);
    assert.deepEqual(payload.transcripts.map((item) => item.availability), ["available", "not_found_or_inaccessible"]);
    assert.equal(payload.transcripts[0].segments.length, 1);
    assert.equal(payload.transcripts[0].segments[0].speaker.classification, "customer");
    assert.equal(payload.transcripts[0].next_segment_cursor, 1);
    assert.equal(payload.source.transcript_persisted, false);
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.ok(requests.some((request) => request.fields?.includes("recording.utterances")));

    const detail = await client.callTool({ name: "get_engagement_detail", arguments: { engagement_ids: ["SYNTH-ENG-001"] } });
    assert.equal(detail.isError, undefined);
    assert.equal(JSON.parse(detail.content[0].text).engagements[0].meeting_summary, "Synthetic summary about a fictional evaluation.");

    const persisted = await readFile(storePath, "utf8");
    assert.doesNotMatch(persisted, new RegExp(knownTranscriptText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(persisted, /recording\.utterances/);
  } finally {
    if (client) await client.close();
    await closeServer(mock);
    await rm(tempDir, { recursive: true, force: true });
  }
});
