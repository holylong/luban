/**
 * Load the running workbench in a real browser, assert that the React app
 * mounted, and capture a screenshot. Uses the DevTools protocol over the
 * WebSocket built into Node, so it needs no extra dependency.
 *
 * Usage: node scripts/web-screenshot.mjs <url> <output.png> [waitMs] [clickSelector]
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const url = process.argv[2] || "http://127.0.0.1:8649/";
const output = resolve(process.argv[3] || ".smoke/dashboard.png");
const waitMs = Number(process.argv[4] || 4000);
const clickSelector = process.argv[5] || "";
const port = 9222 + Math.floor(Math.random() * 500);

function findBrowser() {
  const candidates = [
    join(homedir(), ".cache/ms-playwright/chromium-1228/chrome-linux64/chrome"),
    join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell"),
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
  ];
  return candidates.find(candidate => existsSync(candidate));
}

const browser = findBrowser();
if (!browser) {
  console.error("no chromium binary found");
  process.exit(3);
}

const profile = join(dirname(output), "chrome-profile");
await mkdir(profile, { recursive: true });
const child = spawn(browser, [
  "--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
  "--hide-scrollbars", "--window-size=1680,1000", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
let browserLog = "";
child.stderr.on("data", chunk => { browserLog += chunk.toString(); });

const deadline = Date.now() + 30_000;
let target;
while (Date.now() < deadline) {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await reply.json();
    target = list.find(entry => entry.type === "page");
    if (target?.webSocketDebuggerUrl) break;
  } catch { /* not up yet */ }
  await new Promise(r => setTimeout(r, 200));
}
if (!target?.webSocketDebuggerUrl) {
  child.kill("SIGKILL");
  console.error("devtools endpoint never appeared\n" + browserLog.slice(-800));
  process.exit(4);
}

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const consoleErrors = [];
let nextId = 0;

await new Promise((ok, fail) => { socket.onopen = ok; socket.onerror = fail; });
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
    consoleErrors.push(message.params.args.map(arg => arg.value ?? arg.description ?? "").join(" "));
  }
  if (message.method === "Runtime.exceptionThrown") {
    consoleErrors.push(`exception: ${message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text}`);
  }
};

function send(method, params = {}) {
  const id = ++nextId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((ok, fail) => {
    pending.set(id, message => message.error ? fail(new Error(`${method}: ${message.error.message}`)) : ok(message.result));
    setTimeout(() => { if (pending.delete(id)) fail(new Error(`${method} timed out`)); }, 20_000);
  });
}

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, waitMs));

let clicked = null;
if (clickSelector) {
  const clickResult = await send("Runtime.evaluate", {
    expression: `(() => { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (!el) return null; el.click(); return el.textContent.trim().slice(0, 60); })()`,
    returnByValue: true,
  });
  clicked = clickResult.result.value;
  await new Promise(r => setTimeout(r, 2500));
}

const probe = await send("Runtime.evaluate", {
  expression: `(() => {
    const root = document.getElementById('root');
    const text = (sel) => document.querySelector(sel)?.textContent?.trim() ?? null;
    return {
      title: document.title,
      mounted: Boolean(root && root.childElementCount > 0),
      nodes: root ? root.querySelectorAll('*').length : 0,
      brand: text('.brand strong'),
      emptyHeading: text('.empty h1'),
      placeholder: document.querySelector('.composer textarea')?.getAttribute('placeholder') ?? null,
      tabs: [...document.querySelectorAll('.tab')].map(el => el.textContent.trim()),
      pills: [...document.querySelectorAll('.pill')].map(el => el.textContent.trim()),
      inspectorBlocks: [...document.querySelectorAll('.block h2')].map(el => el.textContent.trim().replace(/\\s+/g, ' ')),
      treeRows: [...document.querySelectorAll('.tree-row')].map(el => el.textContent.trim()),
      composerOptions: [...document.querySelectorAll('.composer-row select option')].map(el => el.textContent.trim()).slice(0, 8),
      stylesheets: document.styleSheets.length,
      runs: [...document.querySelectorAll('.run')].map(el => el.textContent.trim().slice(0, 80)),
      transcript: {
        users: document.querySelectorAll('.avatar.user').length,
        assistant: document.querySelectorAll('.avatar.agent').length,
        tools: [...document.querySelectorAll('.tool .tool-head')].map(el => el.textContent.trim()),
        editSummary: document.querySelector('.edit-summary')?.textContent?.trim() ?? null,
        editLines: [...document.querySelectorAll('.edit-line')].map(el => el.textContent.trim()),
        result: document.querySelector('.result')?.textContent?.trim()?.slice(0, 160) ?? null,
        markdownCode: document.querySelectorAll('.md pre').length,
        markdownStrong: document.querySelectorAll('.md strong').length,
        approvals: document.querySelectorAll('.approval').length,
      },
    };
  })()`,
  returnByValue: true,
});

const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.from(shot.data, "base64"));

socket.close();
child.kill("SIGKILL");

const result = probe.result.value;
console.log(JSON.stringify({ ...result, clicked, consoleErrors, screenshot: output }, null, 2));
if (!result.mounted) {
  console.error("React app did not mount");
  process.exit(1);
}
