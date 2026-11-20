#!/usr/bin/env node
/**
 * Editor reopen probe: does clicking a file again work after closing its tab?
 *
 * The explorer click sets `store.file`, and the editor loads that file in an
 * effect. Keyed on the *path*, the second click on the same file changed
 * nothing, so the effect never ran and the file would not come back until the
 * user opened a different one first. That is a real user-visible dead end, and
 * it is invisible to the static-markup tests, so it gets a real Electron window.
 *
 * Usage: npm run build && node scripts/probe-desktop-editor.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const electronPath = require("electron");

const repo = path.join(__dirname, "..");
process.env.LUBAN_ALLOW_TEMP_WORKSPACES = "1";
const port = 9337;
const fail = message => { console.error("PROBE FAIL:", message); process.exitCode = 1; throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(path.join(repo, "dist/cli.js"))) fail("run npm run build first");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "luban-editor-home-"));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "luban-editor-ws-"));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "luban-editor-profile-"));
  fs.writeFileSync(path.join(folder, "alpha.txt"), "alpha line\n");
  fs.writeFileSync(path.join(folder, "beta.txt"), "beta line\n");
  // Automatic update checks would add a panel to every screenshot; the bot
  // worker would spin on an empty temp home. Turn off the first, claim the lock
  // of the second.
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ updates: { check: false } }, null, 2));
  fs.mkdirSync(path.join(home, "bot", "worker.lock"), { recursive: true });
  fs.writeFileSync(path.join(home, "bot", "worker.lock", "pid"), String(process.pid));

  const child = spawn(electronPath, ["apps/desktop", folder, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], {
    cwd: repo,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LUBAN_HOME: home, ELECTRON_ENABLE_LOGGING: "" },
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
  const until = async (expression, what) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await evaluate(expression)) return;
      await wait(250);
    }
    const text = await evaluate(`document.body?.innerText?.slice(0, 400) ?? ""`);
    return fail(`${what} — page reads: ${JSON.stringify(text)}`);
  };
  /** Click a row in the explorer tree by its visible name. */
  const clickFile = name => evaluate(`(() => {
    const label = [...document.querySelectorAll(".desktop-file-name")].find(node => node.textContent.trim() === ${JSON.stringify(name)});
    if (!label) return false;
    label.closest("button").click();
    return true;
  })()`);
  const tabs = () => evaluate(`[...document.querySelectorAll('.desktop-document-tabs [role="tab"]')].map(node => node.textContent.trim())`);
  const editorText = () => evaluate(`document.querySelector(".desktop-code-editor textarea")?.value ?? null`);
  const welcome = () => evaluate(`Boolean(document.querySelector(".desktop-welcome"))`);

  try {
    await until(`document.querySelectorAll(".desktop-file").length >= 2`, "文件树没有列出 alpha.txt / beta.txt");

    // 1. Open alpha: a tab appears and the editor holds its text.
    if (!(await clickFile("alpha.txt"))) fail("点不到 alpha.txt");
    await until(`Boolean(document.querySelector(".desktop-code-editor textarea"))`, "打开 alpha.txt 后没有编辑器");
    if ((await editorText()) !== "alpha line\n") fail(`alpha.txt 内容不对：${JSON.stringify(await editorText())}`);
    console.log("open   :", JSON.stringify(await tabs()));

    // 2. Close the tab with its × button.
    await evaluate(`document.querySelector('button[aria-label="关闭 alpha.txt"]').click()`);
    await until(`!document.querySelector('button[aria-label="关闭 alpha.txt"]')`, "点关闭后标签还在");
    if (!(await welcome())) fail("关掉唯一标签后没有回到欢迎页");
    console.log("closed :", JSON.stringify(await tabs()));

    // 3. Click the same file again. This is the bug: without a fresh load the
    //    editor stays on the welcome screen and the file looks unopenable.
    if (!(await clickFile("alpha.txt"))) fail("第二次点不到 alpha.txt");
    await until(`Boolean(document.querySelector(".desktop-code-editor textarea"))`, "关掉后再点同一个文件打不开（需要先点别的文件）");
    if ((await editorText()) !== "alpha line\n") fail(`重新打开的内容不对：${JSON.stringify(await editorText())}`);
    console.log("reopen :", JSON.stringify(await tabs()));

    // 4. Same file twice without closing must just refocus, not duplicate tabs.
    await clickFile("beta.txt");
    await until(`!!document.querySelector('button[aria-label="关闭 beta.txt"]')`, "beta.txt 没有打开");
    await clickFile("beta.txt");
    await clickFile("alpha.txt");
    await wait(600);
    const all = await tabs();
    console.log("switch :", JSON.stringify(all));
    if (all.length !== 2) fail(`切来切去标签数量不对：${JSON.stringify(all)}`);
    if ((await editorText()) !== "alpha line\n") fail("切回 alpha.txt 后编辑器不是它的内容");

    // 5. Closing the active tab falls back to the other one, and the closed file
    //    still reopens from the explorer.
    await evaluate(`document.querySelector('button[aria-label="关闭 alpha.txt"]').click()`);
    await until(`!document.querySelector('button[aria-label="关闭 alpha.txt"]')`, "关闭 alpha.txt 失败");
    if ((await editorText()) !== "beta line\n") fail("关掉当前标签后没有切到剩下的标签");
    await clickFile("alpha.txt");
    await until(`Boolean(document.querySelector('button[aria-label="关闭 alpha.txt"]'))`, "关闭当前标签后再点该文件打不开");
    console.log("final  :", JSON.stringify(await tabs()), JSON.stringify(await editorText()));
    console.log("PROBE OK");
  } finally {
    ws.close();
    child.kill("SIGTERM");
    spawnSync("pkill", ["-9", "-f", folder], { stdio: "ignore" });
  }
  process.exit(process.exitCode ?? 0);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
