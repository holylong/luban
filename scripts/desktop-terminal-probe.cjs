#!/usr/bin/env node
/**
 * Terminal pane probe: does opening 终端 stay inside the code column?
 *
 * A real Electron window against a real backend, because the failure mode is
 * layout: xterm paints an exact cols×rows grid, and a grid measured before the
 * panel was visible is wider than the column and bleeds over the agent panel.
 *
 * Usage: npm run build && node scripts/desktop-terminal-probe.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const electronPath = require("electron");

const repo = path.join(__dirname, "..");
const port = 9334;
const fail = message => { console.error("PROBE FAIL:", message); process.exitCode = 1; throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(path.join(repo, "dist/cli.js"))) fail("run npm run build first");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "luban-term-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "luban-term-profile-"));
  fs.writeFileSync(path.join(folder, "a.txt"), "hello\n");
  const child = spawn(electronPath, ["apps/desktop", folder, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_ENABLE_LOGGING: "" },
  });
  let logs = "";
  child.stdout.on("data", chunk => { logs += chunk; });
  child.stderr.on("data", chunk => { logs += chunk; });

  const target = await (async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await wait(500);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const page = list.find(item => item.type === "page" && item.url.includes("desktop=1"));
        if (page) return page;
      } catch { /* Electron is still starting. */ }
    }
    return fail(`no devtools target. logs:\n${logs.slice(-2000)}`);
  })();

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
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text + " " + JSON.stringify(exceptionDetails.exception?.description ?? ""));
    return result.value;
  };

  const geometry = `(() => {
    const box = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    return {
      window: { w: window.innerWidth, h: window.innerHeight },
      page: { scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth },
      editor: box(".desktop-editor"), console: box(".desktop-console"),
      panel: box(".desktop-terminal-panel"), terminal: box(".desktop-terminal"),
      xterm: box(".xterm"), screen: box(".xterm-screen"), agent: box(".desktop-agent"),
      size: document.querySelector(".desktop-terminal-size")?.textContent ?? null,
      cols: window.lubanDesktop ? null : null,
    };
  })()`;

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(500);
      if (await evaluate(`document.querySelectorAll(".desktop-file").length`)) break;
    }
    const before = await evaluate(geometry);
    console.log("before 终端:", JSON.stringify(before));

    await evaluate(`[...document.querySelectorAll(".desktop-console-tabs button")].find(button => button.textContent.trim() === "终端").click()`);
    // xterm loads lazily and the pty has to answer before the grid settles.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await wait(500);
      if (await evaluate(`Boolean(document.querySelector(".xterm-screen"))`)) break;
    }
    await wait(1500);
    const after = await evaluate(geometry);
    console.log("after  终端:", JSON.stringify(after));

    if (after.page.scrollWidth > after.page.clientWidth) fail(`页面横向溢出：${after.page.scrollWidth} > ${after.page.clientWidth}`);
    if (after.console && after.editor && after.console.right > after.editor.right + 1) {
      fail(`控制台右边缘 ${after.console.right} 超出代码列 ${after.editor.right}`);
    }
    if (after.console && after.agent && after.console.right > after.agent.left + 1) {
      fail(`终端覆盖了右侧 Agent 栏：console.right=${after.console.right} agent.left=${after.agent.left}`);
    }
    if (after.terminal && after.console && after.terminal.right > after.console.right + 1) {
      fail(`终端 ${after.terminal.right} 超出控制台 ${after.console.right}`);
    }
    if (after.xterm && after.terminal && after.xterm.right > after.terminal.right + 1) {
      fail(`xterm ${after.xterm.right} 超出面板 ${after.terminal.right}`);
    }
    // Narrow windows are where a fixed grid hurts: the same xterm must shrink,
    // not sit at its birth size and paint over the conversation panel.
    let narrow;
    for (const width of [900, 1180]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
      await wait(900);
      const small = await evaluate(geometry);
      narrow = small;
      console.log(`after  终端 @${width}:`, JSON.stringify(small));
      if (small.page.scrollWidth > small.page.clientWidth) fail(`@${width} 页面横向溢出：${small.page.scrollWidth} > ${small.page.clientWidth}`);
      if (small.terminal && small.terminal.right > small.console.right + 1) fail(`@${width} 终端 ${small.terminal.right} 超出控制台 ${small.console.right}`);
      if (small.xterm && small.terminal && small.xterm.right > small.terminal.right + 1) fail(`@${width} xterm ${small.xterm.right} 超出面板 ${small.terminal.right}`);
      if (small.console.right > small.agent.left + 1) fail(`@${width} 控制台覆盖 Agent 栏：${small.console.right} > ${small.agent.left}`);
      if (!small.size) fail(`@${width} 终端没有报出列×行`);
    }
    // Growing back must re-fit too: a terminal that only ever shrank would
    // leave the pty at 40 columns inside a 96-column panel.
    await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false });
    await wait(1200);
    const grown = await evaluate(geometry);
    console.log("after  终端 @1500:", JSON.stringify(grown));
    if (grown.xterm && grown.terminal && grown.xterm.right > grown.terminal.right + 1) fail(`放回大窗口后 xterm ${grown.xterm.right} 超出面板 ${grown.terminal.right}`);
    const cols = entry => Number(String(entry?.size ?? "").split("×")[0]);
    if (!(cols(grown) > cols(narrow)) ) fail(`放回大窗口后列数没有长回来：${narrow.size} → ${grown.size}`);
    await send("Emulation.clearDeviceMetricsOverride");
    console.log("PROBE OK");
  } finally {
    ws.close();
    child.kill("SIGTERM");
  }
  process.exit(process.exitCode ?? 0);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
