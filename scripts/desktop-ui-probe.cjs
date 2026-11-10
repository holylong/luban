#!/usr/bin/env node
/**
 * Desktop UI probe for the file-tree context menu and the pane splitters.
 *
 * The window is a real Electron one driving a real workspace backend, so this
 * covers what unit tests cannot: the right-click menu appears where the pointer
 * is, the inline name row writes through IPC, and dragging the divider actually
 * moves it instead of ignoring all but the last pointer event.
 *
 * Usage: npm run build && node scripts/desktop-ui-probe.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const electronPath = require("electron");

const repo = path.join(__dirname, "..");
const port = 9333;
const fail = message => { console.error("PROBE FAIL:", message); process.exitCode = 1; throw new Error(message); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  if (!fs.existsSync(path.join(repo, "dist/cli.js"))) fail("run npm run build first");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "luban-ui-"));
  // A separate profile keeps this probe out of a running luban's single-instance
  // lock, and gives it a saved-workspace-free config.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "luban-ui-profile-"));
  fs.writeFileSync(path.join(folder, "a.txt"), "hello\n");
  fs.mkdirSync(path.join(folder, "src"));
  fs.writeFileSync(path.join(folder, "src/app.ts"), "export const answer = 42;\n");

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
  const mouse = (type, x, y, button = "left", buttons = 1) => send("Input.dispatchMouseEvent", { type, x, y, button, buttons, clickCount: 1 });

  try {
    // The tree paints once the backend has listed the folder.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await wait(500);
      const ready = await evaluate(`document.querySelectorAll(".desktop-file").length`);
      if (ready >= 2) break;
    }
    const rows = await evaluate(`[...document.querySelectorAll(".desktop-file")].map(row => row.textContent.trim())`);
    if (!rows.some(row => row.includes("a.txt")) || !rows.some(row => row.includes("src"))) fail(`tree shows ${JSON.stringify(rows)}`);

    // Right-click a file: the menu opens at the pointer with the file actions.
    const spot = await evaluate(`(() => {
      const row = [...document.querySelectorAll(".desktop-file")].find(item => item.textContent.includes("a.txt"));
      const box = row.getBoundingClientRect();
      return { x: Math.round(box.x + 40), y: Math.round(box.y + 10) };
    })()`);
    await evaluate(`(() => {
      const row = [...document.querySelectorAll(".desktop-file")].find(item => item.textContent.includes("a.txt"));
      const box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.x + 40, clientY: box.y + 10 }));
    })()`);
    await wait(300);
    const menu = await evaluate(`(() => {
      const node = document.querySelector(".desktop-menu");
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return { labels: [...node.querySelectorAll("button")].map(button => button.textContent.trim()), box: { left: Math.round(box.left), top: Math.round(box.top) } };
    })()`);
    if (!menu) fail("右键没有出现菜单");
    for (const label of ["打开", "在访达中显示", "复制路径", "重命名", "移到废纸篓"]) {
      if (!menu.labels.includes(label)) fail(`菜单缺少「${label}」：${JSON.stringify(menu.labels)}`);
    }
    if (Math.abs(menu.box.left - spot.x) > 12 || Math.abs(menu.box.top - spot.y) > 12) fail(`菜单位置 ${JSON.stringify(menu.box)} 不在鼠标 ${JSON.stringify(spot)}`);
    console.log("右键菜单:", menu.labels.join(" / "));

    // 复制路径 must reach the system clipboard.
    await evaluate(`[...document.querySelectorAll(".desktop-menu button")].find(button => button.textContent.trim() === "复制路径").click()`);
    await wait(400);
    const clipboard = execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }).trim();
    if (!clipboard.endsWith("a.txt") || !clipboard.includes(folder)) fail(`剪贴板里是 ${JSON.stringify(clipboard)}`);
    console.log("复制路径 →", clipboard);

    // 新建文件 in the root listing, named by the inline row.
    await evaluate(`(() => {
      const area = document.querySelector(".desktop-explorer-scroll");
      const box = area.getBoundingClientRect();
      area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: box.x + 30, clientY: box.y + box.height - 10 }));
    })()`);
    await wait(300);
    await evaluate(`(() => {
      const button = [...document.querySelectorAll(".desktop-menu button")].find(item => item.textContent.trim() === "新建文件");
      if (!button) throw new Error("no 新建文件");
      button.click();
    })()`);
    await wait(300);
    await evaluate(`document.querySelector(".desktop-file-edit input").focus()`);
    await send("Input.insertText", { text: "notes.md" });
    await evaluate(`document.querySelector(".desktop-file-edit").requestSubmit()`);
    await wait(1200);
    if (!fs.existsSync(path.join(folder, "notes.md"))) fail("新建文件没有写到磁盘");
    const afterCreate = await evaluate(`[...document.querySelectorAll(".desktop-file")].map(row => row.textContent.trim())`);
    if (!afterCreate.some(row => row.includes("notes.md"))) fail(`新建的文件没出现在文件树：${JSON.stringify(afterCreate)}`);
    console.log("新建文件 → notes.md");

    // The conversation panel sits on the right, so dragging its divider right
    // narrows it. It must follow every pointer event, not just the last one.
    const before = await evaluate(`Math.round(document.querySelector(".desktop-agent").getBoundingClientRect().width)`);
    const handle = await evaluate(`(() => {
      const box = [...document.querySelectorAll(".desktop-splitter.vertical")][1].getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 60) };
    })()`);
    await mouse("mousePressed", handle.x, handle.y);
    for (let step = 1; step <= 6; step += 1) {
      await mouse("mouseMoved", handle.x + step * 20, handle.y);
      await wait(40);
    }
    await mouse("mouseReleased", handle.x + 120, handle.y, "left", 0);
    await wait(400);
    const after = await evaluate(`Math.round(document.querySelector(".desktop-agent").getBoundingClientRect().width)`);
    if (!(before - after >= 100)) fail(`拖动只把会话栏从 ${before}px 变到 ${after}px`);
    console.log("会话栏拖动:", `${before}px → ${after}px`);

    // Dragging far right must stop at the minimum, not squeeze the editor out.
    const handle2 = await evaluate(`(() => {
      const box = [...document.querySelectorAll(".desktop-splitter.vertical")][1].getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + 60) };
    })()`);
    await mouse("mousePressed", handle2.x, handle2.y);
    for (let step = 1; step <= 5; step += 1) {
      await mouse("mouseMoved", handle2.x + step * 120, handle2.y);
      await wait(40);
    }
    await mouse("mouseReleased", handle2.x + 600, handle2.y, "left", 0);
    await wait(400);
    const narrow = await evaluate(`(() => ({
      agent: Math.round(document.querySelector(".desktop-agent").getBoundingClientRect().width),
      editor: Math.round(document.querySelector(".desktop-editor").getBoundingClientRect().width),
    }))()`);
    if (narrow.agent !== 240) fail(`最窄没有停在 240px：${JSON.stringify(narrow)}`);
    if (narrow.editor < 320) fail(`编辑器被压到 ${narrow.editor}px`);
    console.log("最窄:", JSON.stringify(narrow));
  } finally {
    ws.close();
    child.kill("SIGTERM");
  }
  console.log("PROBE OK");
  process.exit(process.exitCode ?? 0);
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
