#!/usr/bin/env node
/**
 * Update panel probe: does the real desktop window find a release, offer it, and
 * write the same config the CLI reads?
 *
 * A real Electron window against a fake release server, because the failure
 * modes here are wiring ones the jsdom tests cannot see: a bundle that is not
 * rebuilt, a `/api/update` route that never reaches the catalog, a checkbox that
 * toggles in React state but never lands in `config.json`.
 *
 * Starts with `updates.check: false` so the main process never opens its own
 * startup dialog over the window; the probe then does what a user would do —
 * tick the box, watch the new version appear, press 不再提醒, reopen the panel.
 *
 * Usage: npm run build && node scripts/probe-desktop-update.cjs
 */
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const electronPath = require("electron");

const repo = path.join(__dirname, "..");
const NEW_VERSION = "2.9.9";
// Registered as a workspace, so the temp-folder guard needs the same opt-in the
// other desktop probes use.
process.env.LUBAN_ALLOW_TEMP_WORKSPACES = "1";
const port = 9336;
const fail = message => { console.error("PROBE FAIL:", message); process.exitCode = 1; throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The release server a real client would talk to, reduced to one answer. */
function fakeReleaseServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    seen.push(url.pathname + url.search);
    if (!url.pathname.endsWith("/api/update")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not a probe route");
      return;
    }
    const platform = url.searchParams.get("platform") ?? "darwin";
    const arch = url.searchParams.get("arch") ?? "x64";
    const kind = url.searchParams.get("kind") ?? "desktop";
    const notes = "探针：这是假的新版本，用来看面板会不会自己弹出来。";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true, platform, arch, kind,
      latest: { version: NEW_VERSION, publishedAt: new Date().toISOString(), notes },
      artifact: {
        version: NEW_VERSION, publishedAt: new Date().toISOString(), notes,
        file: `luban-${kind}-${NEW_VERSION}-mac-${arch}.zip`, url: "/downloads/probe.zip",
        sha256: "0".repeat(64), size: 1024, kind, platform, arch,
      },
    }));
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

(async () => {
  if (!fs.existsSync(path.join(repo, "dist/cli.js"))) fail("run npm run build first");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "luban-update-home-"));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "luban-update-ws-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "luban-update-profile-"));
  fs.writeFileSync(path.join(folder, "a.txt"), "hello\n");
  // Automatic checking starts off, so the probe drives the switch itself.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ updates: { check: false } }, null, 2));
  // A desktop window starts `luban bot run` as soon as it has a backend, and on
  // an empty temp home that worker just burns cycles. Claim the lock so
  // `startBot()` sees an owner and leaves the queue alone.
  fs.mkdirSync(path.join(home, "bot", "worker.lock"), { recursive: true });
  fs.writeFileSync(path.join(home, "bot", "worker.lock", "pid"), String(process.pid));
  const configFile = path.join(home, "config.json");
  const readConfig = () => JSON.parse(fs.readFileSync(configFile, "utf8"));

  const fake = await fakeReleaseServer();
  // LUBAN_PROBE_APP runs the same probe against a packaged .app (mount the dmg
  // and point it at Contents/MacOS/luban), which is the only way to see that the
  // dock actually shipped inside the bundle.
  const packaged = process.env.LUBAN_PROBE_APP;
  const command = packaged || electronPath;
  const args = packaged
    ? [folder, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`]
    : ["apps/desktop", folder, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`];
  const child = spawn(command, args, {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LUBAN_HOME: home, LUBAN_UPDATES_URL: fake.base, ELECTRON_ENABLE_LOGGING: "" },
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
  /** Poll a predicate in the page until it holds, or say what the DOM looked like. */
  const until = async (expression, what) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(expression)) return;
      await wait(500);
    }
    const text = await evaluate(`document.querySelector(".update-panel")?.innerText ?? "(no panel)"`);
    const page = await evaluate(`location.href + " :: " + (document.body?.innerText ?? "").slice(0, 400)`);
    return fail(`${what} — panel reads: ${JSON.stringify(text)}; page: ${JSON.stringify(page)}`);
  };
  const headline = () => evaluate(`document.querySelector(".update-state")?.textContent ?? ""`);
  const buttons = () => evaluate(`[...document.querySelectorAll(".update-actions button")].map(b => b.textContent.trim())`);

  try {
    await until(`Boolean(document.querySelector(".update-button"))`, "侧栏没有出现更新按钮");
    console.log("dock:", JSON.stringify(await evaluate(`document.querySelector(".update-button").textContent.trim()`)));
    if (readConfig().updates?.check !== false) fail("probe config was rewritten before the user did anything");

    // 1. Open the dock: automatic checking is off, so the panel must say so
    //    rather than pretend the release server is unreachable.
    await evaluate(`document.querySelector(".update-button").click()`);
    await until(`Boolean(document.querySelector(".update-panel"))`, "点「更新」没有打开面板");
    const disabled = await headline();
    console.log("check off:", JSON.stringify(disabled));
    if (!disabled.includes("已关闭")) fail(`开关关掉时面板该说已关闭，实际：${disabled}`);

    // 2. Tick 启动时检查更新: the renderer writes config and immediately re-checks.
    await evaluate(`document.querySelector(".update-check input").click()`);
    await until(`(document.querySelector(".update-state")?.textContent ?? "").includes(${JSON.stringify(NEW_VERSION)})`,
      `勾上开关后没有查到 ${NEW_VERSION}`);
    const available = await headline();
    const actions = await buttons();
    console.log("check on:", JSON.stringify(available), JSON.stringify(actions));
    if (!available.includes(`新版本 ${NEW_VERSION}`)) fail(`面板没有报新版本：${available}`);
    if (!actions.some(label => label.includes(`升级到 ${NEW_VERSION}`))) fail(`没有升级按钮：${actions.join(" / ")}`);
    for (const label of ["不再提醒", "稍后", "立即检查"]) {
      if (!actions.includes(label)) fail(`缺少「${label}」按钮：${actions.join(" / ")}`);
    }
    if (readConfig().updates?.check !== true) fail("勾选没有写进 config.json");
    // A waiting release has to be visible with the dock collapsed too.
    await evaluate(`[...document.querySelectorAll(".update-actions button")].find(b => b.textContent.trim() === "稍后").click()`);
    await until(`!document.querySelector(".update-panel")`, "点「稍后」没有收起面板");
    if (!(await evaluate(`Boolean(document.querySelector(".update-dot"))`))) fail("有可安装的版本，收起的侧栏没有蓝点");
    await evaluate(`document.querySelector(".update-button").click()`);
    await until(`Boolean(document.querySelector(".update-panel"))`, "收起后再次点「更新」没有打开面板");

    // 3. 不再提醒 writes the version into the same block `luban update off` uses.
    await evaluate(`[...document.querySelectorAll(".update-actions button")].find(b => b.textContent.trim() === "不再提醒").click()`);
    await until(`(document.querySelector(".update-state")?.textContent ?? "").includes("不再提醒")`, "点「不再提醒」后状态没有变");
    const skipped = readConfig().updates?.skipped_version;
    console.log("skipped:", JSON.stringify(await headline()), "config:", JSON.stringify(skipped));
    if (skipped !== NEW_VERSION) fail(`config.json 里的 skipped_version 是 ${JSON.stringify(skipped)}`);

    // 4. 稍后 collapses the dock; reopening it keeps the skipped state instead of
    //    silently re-announcing the same version, and a hushed version has no dot.
    await evaluate(`[...document.querySelectorAll(".update-actions button")].find(b => b.textContent.trim() === "稍后").click()`);
    await until(`!document.querySelector(".update-panel")`, "点「稍后」没有收起面板");
    if (await evaluate(`Boolean(document.querySelector(".update-dot"))`)) fail("「不再提醒」之后侧栏还挂着蓝点");
    await evaluate(`document.querySelector(".update-button").click()`);
    await until(`Boolean(document.querySelector(".update-panel"))`, "再次点「更新」没有打开面板");
    const reopened = await headline();
    console.log("reopened:", JSON.stringify(reopened));
    if (!reopened.includes("不再提醒")) fail(`重新打开后状态不对：${reopened}`);

    // 5. 立即检查 still shows the skipped version: "不再提醒" hushes the banner,
    //    it does not hide the build from someone who asks on purpose.
    await evaluate(`[...document.querySelectorAll(".update-actions button")].find(b => b.textContent.trim() === "立即检查").click()`);
    await wait(1200);
    const manual = await headline();
    console.log("manual check:", JSON.stringify(manual));
    if (!manual.includes(NEW_VERSION)) fail(`手动检查没有再问服务器：${manual}`);

    // 6. Turn the switch back off: the panel must fall back to 已关闭 and the
    //    config must not keep a stale "true".
    await evaluate(`document.querySelector(".update-check input").click()`);
    await until(`(document.querySelector(".update-state")?.textContent ?? "").includes("已关闭")`, "取消勾选后没有回到已关闭");
    if (readConfig().updates?.check !== false) fail("取消勾选没有写回 config.json");
    console.log("final config:", JSON.stringify(readConfig().updates));
    console.log("release server saw:", JSON.stringify([...new Set(fake.seen.map(entry => entry.split("?")[0]))]));
    if (!fake.seen.some(entry => entry.startsWith("/api/update?"))) fail("面板从未访问过升级服务器");
    console.log("PROBE OK");
  } finally {
    ws.close();
    child.kill("SIGTERM");
    fake.server.close();
    // Each window starts a workspace daemon of its own, and a SIGTERM to the
    // window does not take that daemon with it; clean up what this probe made.
    spawnSync("pkill", ["-9", "-f", folder], { stdio: "ignore" });
  }
  process.exit(process.exitCode ?? 0);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
