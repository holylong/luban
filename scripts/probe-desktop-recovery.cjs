#!/usr/bin/env node
/**
 * Renderer-death probe: after the renderer dies mid-work, does the window come
 * back by itself?
 *
 * The reported symptom is "干着干着活就成一个黑板了，只能关了重开": the native
 * window keeps painting its #050607 background while the dead renderer never
 * repaints. CDP Page.crash kills the renderer exactly like an OOM or a GPU
 * teardown does, so this probe reproduces it without waiting for a real crash.
 *
 * Usage: npm run build && node scripts/probe-desktop-recovery.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const electronPath = require("electron");

const repo = path.join(__dirname, "..");
process.env.LUBAN_ALLOW_TEMP_WORKSPACES = "1";
// A leftover instance from an interrupted run would otherwise take the port and
// turn the next probe into a devtools-bind error instead of a real result.
const freePort = () => new Promise((resolve, reject) => {
  const server = require("node:net").createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});
let port = 0;
const fail = message => { console.error("PROBE FAIL:", message); process.exitCode = 1; throw new Error(message); };
// Electron shuts its workers down on SIGTERM, so a killed probe must not leave a
// window (and its port) behind for the next one.
const stopChild = async child => {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(250);
    if (child.exitCode !== null || child.signalCode) return;
  }
  child.kill("SIGKILL");
  await wait(250);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// A crashed renderer's socket answers nothing at all, so every CDP call needs
// its own deadline instead of a promise that never settles.
const withTimeout = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what} 超时 ${ms}ms`)), ms).unref?.()),
]);

function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}, timeoutMs = 15000) => withTimeout(new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  }), timeoutMs, method);
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text + " " + JSON.stringify(exceptionDetails.exception?.description ?? ""));
    return result.value;
  };
  return { ws, ready, send, evaluate };
}

async function findPage(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(400);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find(item => item.type === "page" && item.url.includes("desktop=1"));
      if (page) return page;
    } catch { /* Electron is still starting. */ }
  }
  return undefined;
}

(async () => {
  if (!fs.existsSync(path.join(repo, "dist/cli.js"))) fail("run npm run build first");
  port = await freePort();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "luban-recover-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "luban-recover-profile-"));
  fs.writeFileSync(path.join(folder, "notes.txt"), "hello\n");
  const child = spawn(electronPath, ["apps/desktop", folder, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" },
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });

  try {
    const first = await findPage(30000) || fail(`no devtools target. logs:\n${logs.slice(-2000)}`);
    const page1 = connect(first);
    await page1.ready;
    // The backend is still starting on the first tries, so a slow answer here is
    // not a failure — keep polling until the file tree exists.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(500);
      try { if (await page1.evaluate(`document.querySelectorAll(".desktop-file").length`)) break; }
      catch { /* renderer still busy opening the workspace */ }
    }
    const files = await page1.evaluate(`document.querySelectorAll(".desktop-file").length`);
    if (!files) fail("工作区文件树没有渲染出来，探针无法判断黑屏");
    await page1.evaluate(`window.__probeDocument = "original"`);
    console.log(`before crash: target=${first.id} files=${files}`);

    const startedAt = Date.now();
    // Page.crash tears the renderer down without any renderer-side handler, so
    // only main-process recovery can bring the window back.
    await page1.send("Page.crash").catch(() => { /* the socket dies with the renderer */ });
    try { page1.ws.close(); } catch { /* already closed */ }

    // Recovery is either a rebuilt window (new target id) or a reloaded one
    // (same id, fresh document); both must repaint the workbench by themselves.
    let recovered;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(500);
      const page = await findPage(1000);
      if (!page) continue;
      let page2;
      try { page2 = connect(page); await page2.ready; } catch { continue; }
      try {
        const alive = await page2.evaluate(`document.querySelectorAll(".desktop-file").length`);
        const fresh = await page2.evaluate(`window.__probeDocument === undefined`);
        const status = await page2.evaluate(`document.querySelector(".desktop-status")?.textContent ?? ""`);
        if (alive && fresh) { recovered = { page, alive, status, fresh }; break; }
      } catch { /* the target is still the dead renderer */ }
      try { page2.ws.close(); } catch { /* ignore */ }
      if (Date.now() - startedAt > 45000) break;
    }
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!recovered) fail(`${elapsed}s 内窗口没有自己恢复：仍是崩溃后的空白/黑板窗口`);
    console.log(`after crash: ${elapsed}s newTarget=${first.id !== recovered.page.id} files=${recovered.alive} status="${recovered.status.trim()}"`);
    if (!recovered.status.includes("已连接")) fail(`窗口恢复了但后端没连上：${recovered.status}`);

    // Phase 2: a wedged renderer. A long synchronous loop blocks the event loop
    // exactly like a bad transcript render, so only the unresponsive watchdog
    // can get the window back.
    const wedged = connect(recovered.page);
    await wedged.ready;
    const wedgedAt = Date.now();
    // Fire and forget: a blocked renderer never answers this call.
    wedged.ws.send(JSON.stringify({ id: 990001, method: "Runtime.evaluate", params: { expression: "(() => { const t = Date.now(); while (Date.now() - t < 120000) {} })()" } }));
    let thawed;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await wait(500);
      const page = await findPage(1000);
      if (!page) continue;
      let page3;
      try { page3 = connect(page); await page3.ready; } catch { continue; }
      try {
        const alive = await page3.evaluate(`document.querySelectorAll(".desktop-file").length`);
        const fresh = await page3.evaluate(`window.__probeDocument === undefined && window.__probeDocument2 === undefined`);
        if (alive && fresh) { thawed = { page, alive }; break; }
      } catch { /* still the hung renderer */ }
      try { page3.ws.close(); } catch { /* ignore */ }
      if (Date.now() - wedgedAt > 60000) break;
    }
    const thawMs = ((Date.now() - wedgedAt) / 1000).toFixed(1);
    if (!thawed) fail(`${thawMs}s 内卡死的窗口没有恢复`);
    console.log(`after wedge: ${thawMs}s newTarget=${recovered.page.id !== thawed.page.id} files=${thawed.alive}`);

    // Phase 3: the crash-loop fallback. The second GPU crash writes this flag;
    // the next start must come up with the software compositor and say so, or
    // the machine keeps producing black boards and nobody can tell why.
    await stopChild(child);
    fs.writeFileSync(path.join(profile, "no-gpu"), new Date().toISOString());
    const fallback = spawn(electronPath, ["apps/desktop", folder, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
      cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" },
    });
    fallback.stdout.on("data", chunk => { logs += chunk; });
    fallback.stderr.on("data", chunk => { logs += chunk; });
    const restarted = await findPage(30000);
    if (!restarted) fail(`带 no-gpu 标记启动后没有窗口。logs:\n${logs.slice(-2000)}`);
    const log = fs.readFileSync(path.join(profile, "desktop.log"), "utf8");
    if (!log.includes("hardware acceleration disabled")) fail(`no-gpu 标记没有被采纳：\n${log.slice(-400)}`);
    console.log("after restart: hardware acceleration disabled and the window opened");
    await stopChild(fallback);
    console.log("PROBE OK");
  } finally {
    await stopChild(child);
  }
  process.exit(process.exitCode ?? 0);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
