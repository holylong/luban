import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeshRuntime } from "../src/core/mesh/runtime.js";
import { LubanWebServer } from "../src/web/server.js";
import { LubanRelayServer } from "../src/web/relay.js";
import { TunnelClient } from "../src/web/tunnel.js";
import { VERSION } from "../src/version.js";

/**
 * Full-chain smoke test: phone → relay → tunnel → local web → job runner.
 *
 * The job runner is scripted (like the unit tests do) so the check exercises
 * the transport, auth and streaming rather than a live model.
 */
const root = await mkdtemp(join(tmpdir(), "luban-e2e-"));
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "README.md"), "e2e\n", "utf8");
const model = { id: "test/model", provider: "test", model: "model", name: "Test", baseUrl: "http://127.0.0.1", apiKey: "" };
const config = {
  home: join(root, "home"), workspace, project: "e2e", model, models: [model],
  maxTokens: 1000, temperature: 0, timeoutMs: 10_000, maxSteps: 5,
  backendUrl: "", permissionMode: "allow",
  mesh: {
    enabled: true, nodeName: "e2e-node", host: "127.0.0.1", port: 0, udpPort: 0,
    capabilities: ["agent"], contacts: [], token: "", syncMode: "chunk",
    chunkSize: 1024, syncIgnore: [".git"], conflictPolicy: "auto",
    jobsDir: join(root, "home", "jobs"), workspacesDir: join(root, "home", "workspaces"),
    projects: {}, maxWorkers: 1, jobTimeoutSeconds: 60, queueTimeoutSeconds: 60,
  },
};

const relay = new LubanRelayServer({ host: "127.0.0.1", port: 0, token: "phone-tok", nodeToken: "node-tok" });
const relayUrl = await relay.start();

const mesh = new MeshRuntime(config);
mesh.setJobRunner(async (job, signal, log, record) => {
  log("info", "thinking about it");
  // Structured events are what the console renders as tool cards, so emit them
  // the way the real agent runner does.
  record({ kind: "tool-start", callId: "call-1", name: "read_file", args: { path: "README.md" }, summary: "README.md" });
  record({ kind: "tool-end", callId: "call-1", name: "read_file", ok: true, elapsedMs: 12, preview: "e2e\n" });
  for (let i = 0; i < 5 && !signal.aborted; i++) {
    await new Promise(resolveStep => setTimeout(resolveStep, 120));
  }
  return { ok: true, text: `done: ${job.instruction}` };
});
const web = new LubanWebServer(config, mesh, { host: "127.0.0.1", port: 0, token: "local-tok" });
await mesh.start();
const webUrl = await web.start();

const tunnel = new TunnelClient({
  relayUrl, nodeToken: "node-tok", localPort: web.port, localHost: "127.0.0.1", localToken: "local-tok",
  name: "e2e-node", version: VERSION, workspace, projects: { e2e: workspace },
});
await tunnel.start();

const phone = (path, init = {}) => fetch(`${relayUrl}${path}`, { ...init, headers: { cookie: "luban_token=phone-tok", ...init.headers } });
const sleep = ms => new Promise(resolveTimer => setTimeout(resolveTimer, ms));

// Wait for the node to appear online through the relay.
let online = false;
for (let i = 0; i < 60 && !online; i++) {
  const reply = await phone("/relay/nodes");
  const body = await reply.json();
  online = body.nodes?.[0]?.online === true;
  if (!online) await sleep(100);
}
console.log("node online via relay:", online);

const nodeInfo = await (await phone("/api/node")).json();
console.log("api/node through tunnel:", nodeInfo.name, nodeInfo.workspace === workspace ? "workspace-ok" : "workspace-MISMATCH");

// Submit a job the way the phone console does.
const submitted = await (await phone("/api/jobs", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ instruction: "整理 README 并总结", project_id: "e2e", mode: "edits", interaction: "on" }),
})).json();
console.log("submitted:", submitted.job_id, submitted.status);

// The job detail stream is a JSON endpoint the console polls (the SSE channel
// is /api/events, checked separately below). Poll it the way the phone does:
// `complete` only says the replay window covers what exists so far, so the
// loop ends on the job's terminal status, not on that flag.
let since = 0;
let sawTool = false;
let final = { status: "queued" };
const startedAt = Date.now();
while (Date.now() - startedAt < 20_000) {
  const reply = await (await phone(`/api/jobs/${submitted.job_id}/stream?since=${since}`)).json();
  for (const record of reply.events || []) {
    since = Math.max(since, record.seq);
    if (JSON.stringify(record.event).includes("read_file")) sawTool = true;
  }
  final = await (await phone(`/api/jobs/${submitted.job_id}`)).json();
  if (["done", "failed", "cancelled"].includes(final.status)) break;
  await sleep(150);
}
console.log("stream replayed tool events:", sawTool, "| after", Date.now() - startedAt, "ms");

// The SSE channel carries live job updates; confirm it streams through the tunnel.
const eventsResponse = await phone("/api/events");
const contentType = eventsResponse.headers.get("content-type") || "";
const sseStreaming = contentType.includes("text/event-stream");
await eventsResponse.body?.cancel().catch(() => undefined);
console.log("SSE /api/events streams through tunnel:", sseStreaming);

console.log("job final:", final.status, "|", (final.result || "").slice(0, 40));

// The local token must never leak into what the phone sees.
const raw = JSON.stringify(final);
console.log("local token leaked:", raw.includes("local-tok"));

tunnel.stop();
await web.stop();
await mesh.stop();
await relay.stop();
await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
const pass = online && sawTool && sseStreaming && final.status === "done" && !raw.includes("local-tok");
console.log(pass ? "E2E PASS" : "E2E FAIL");
process.exit(pass ? 0 : 1);
