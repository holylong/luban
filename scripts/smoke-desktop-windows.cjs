#!/usr/bin/env node
/**
 * Multi-window smoke test for the desktop main process.
 *
 * Electron cannot run headless in CI, so this harness stubs only the Electron
 * API surface main.cjs touches (windows, IPC, dialogs, tray, the media scheme).
 * Everything else is real: the workspace services and the loopback backends are
 * spawned from dist/cli.js. It proves that two windows own two projects, and that
 * IPC, the media scheme and an in-place folder switch each stay inside their own
 * window, and that closing one window leaves the others working.
 *
 * Usage: npm run build && node scripts/smoke-desktop-windows.cjs
 */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const Module = require("node:module");
const { EventEmitter } = require("node:events");

const repo = path.join(__dirname, "..");

function createElectron() {
  let idSeq = 0;
  let readyCallback;
  const windows = [];
  const registered = new Map();
  const protocol = {
    registerSchemesAsPrivileged() {},
    handle(_scheme, handler) { protocol.handler = handler; },
  };

  class FakeWebContents extends EventEmitter {
    constructor(win) {
      super();
      this.id = ++idSeq;
      this.win = win;
      this.mainFrame = { url: "about:blank" };
      this.url = "about:blank";
      this.sent = [];
    }
    getURL() { return this.url; }
    setWindowOpenHandler() {}
    send(channel, payload) { this.sent.push({ channel, payload }); }
  }

  class BrowserWindow extends EventEmitter {
    constructor(options = {}) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents(this);
      this.destroyed = false;
      this.title = "";
      this.visible = false;
      this.loads = [];
      windows.push(this);
    }
    static getFocusedWindow() { return windows.filter(win => !win.destroyed).at(-1) ?? null; }
    static fromWebContents(contents) { return contents.win; }
    loadURL(url) {
      this.loads.push(url);
      this.webContents.url = url;
      this.webContents.mainFrame.url = url;
      // Real Electron commits the navigation asynchronously; the session guard
      // rebuilds its workspace service from this event.
      setImmediate(() => this.webContents.emit("did-frame-navigate", {}, url, 200, "OK", true));
      return Promise.resolve();
    }
    loadFile() { return Promise.resolve(); }
    setTitle(title) { this.title = title; }
    show() { this.visible = true; this.emit("show"); }
    hide() { this.visible = false; this.emit("hide"); }
    focus() { this.emit("focus"); }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    restore() {}
    destroy() {
      this.emit("close", { preventDefault() {} });
      this.destroyed = true;
      this.emit("closed");
    }
  }

  class Tray extends EventEmitter {
    constructor(image) { super(); this.image = image; this.destroyed = false; }
    setToolTip(text) { this.tooltip = text; }
    setContextMenu(menu) { this.menu = menu; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }

  class Menu {
    static buildFromTemplate(template) { return { template }; }
    static setApplicationMenu(menu) { this.current = menu; }
  }

  const app = {
    setName(name) { this.name = name; },
    getPath() { return process.env.LUBAN_SMOKE_USERDATA; },
    getAppPath() { return repo; },
    whenReady() {
      const ready = { then: resolve => { readyCallback = resolve; return ready; } };
      ready.catch = () => ready;
      return ready;
    },
    quit() { this.quitCalled = true; },
    requestSingleInstanceLock() { return true; },
    on() {},
  };
  const ipcMain = {
    handle(channel, handler) { registered.set(channel, handler); },
    on(channel, handler) { registered.set(channel, handler); },
  };
  const dialog = {
    showErrorBox: (title, detail) => { console.error("[dialog]", title, detail); },
    showMessageBoxSync: () => 1,
    // 0 = 新窗口打开, 1 = 在当前窗口打开, 2 = 取消
    showMessageBox: async () => ({ response: Number(process.env.LUBAN_SMOKE_OPEN_MODE ?? 0) }),
    showOpenDialog: async () => ({ canceled: false, filePaths: [process.env.LUBAN_SMOKE_PICK] }),
  };

  return {
    app, BrowserWindow, Tray, Menu, ipcMain, dialog, protocol,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }) },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    shell: {
      openPath: async () => "",
      showItemInFolder(target) { electron.__smoke.revealed.push(target); },
      trashItem: async target => { electron.__smoke.trashed.push(target); },
    },
    clipboard: { writeText(text) { electron.__smoke.clipboard = text; } },
    __smoke: { windows, registered, protocol, revealed: [], trashed: [], clipboard: "", run: () => readyCallback?.() },
  };
}

const electron = createElectron();
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return electron;
  return originalLoad.call(this, request, parent, isMain);
};

const smoke = electron.__smoke;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { console.error("SMOKE FAIL:", message); process.exit(1); };
const workbench = () => smoke.windows.filter(win => win.loads.length > 0 && !win.destroyed);
const eventFor = win => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
const portOf = win => new URL(win.loads[0]).port;

(async () => {
  if (!fs.existsSync(path.join(repo, "dist/cli.js"))) fail("run npm run build first");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "luban-smoke-"));
  const folderA = fs.mkdtempSync(path.join(os.tmpdir(), "luban-a-"));
  const folderB = fs.mkdtempSync(path.join(os.tmpdir(), "luban-b-"));
  const folderC = fs.mkdtempSync(path.join(os.tmpdir(), "luban-c-"));
  fs.writeFileSync(path.join(folderA, "a.txt"), "A\n");
  fs.writeFileSync(path.join(folderA, "clip.mp4"), "A");
  fs.writeFileSync(path.join(folderB, "b.txt"), "B\n");
  fs.writeFileSync(path.join(folderB, "clip.mp4"), "B");
  fs.writeFileSync(path.join(folderC, "c.txt"), "C\n");
  fs.writeFileSync(path.join(userData, "workspace.json"), JSON.stringify({ path: folderA }));
  process.env.LUBAN_SMOKE_USERDATA = userData;
  process.env.LUBAN_SMOKE_PICK = folderB;
  process.env.LUBAN_CLI = path.join(repo, "dist/cli.js");

  require(path.join(repo, "apps/desktop/main.cjs"));
  smoke.run();
  await wait(6000);
  const first = workbench()[0];
  if (!first) fail("no window opened");
  if (!first.title.includes("luban-a")) fail(`unexpected first title: ${first.title}`);
  console.log("window 1:", first.title, portOf(first));

  // 文件 → 打开项目文件夹 on a second folder opens a second window.
  const openWindow = smoke.registered.get("luban:openWorkspaceWindow");
  if (!openWindow) fail("openWorkspaceWindow handler missing");
  const reply = await openWindow(eventFor(first));
  if (reply.path !== folderB) fail(`unexpected reply: ${JSON.stringify(reply)}`);
  await wait(7000);
  const second = workbench()[1];
  if (!second) fail("second window never opened");
  if (!second.title.includes("luban-b")) fail(`second window shows ${second.title}`);
  if (portOf(first) === portOf(second)) fail("both windows share one backend");
  console.log("window 2:", second.title, portOf(second));

  const listFiles = smoke.registered.get("luban:listFiles");
  const filesOf = win => listFiles(eventFor(win), undefined);
  if (!(await filesOf(first)).includes("a.txt")) fail("first window lost its folder");
  if (!(await filesOf(second)).includes("b.txt")) fail("second window did not see its own folder");

  const fileMenu = electron.Menu.current.template[0].submenu;
  const menuItem = prefix => {
    const item = fileMenu.find(entry => String(entry.label).startsWith(prefix));
    if (!item) fail(`menu item missing: ${prefix}`);
    return item;
  };

  // 文件 → 新建窗口 must really open one, not focus the current window.
  await menuItem("新建窗口").click();
  await wait(7000);
  if (workbench().length !== 3) fail("文件 → 新建窗口 did not open a window");
  const fromMenu = workbench()[2];
  if (!fromMenu.title.includes("luban-b")) fail(`新建窗口 opened ${fromMenu.title}`);
  console.log("菜单新建窗口:", fromMenu.title, portOf(fromMenu));
  fromMenu.destroy();
  await wait(1500);

  // The in-app button must open a window even for an already open folder.
  process.env.LUBAN_SMOKE_PICK = folderA;
  await openWindow(eventFor(second));
  await wait(7000);
  if (workbench().length !== 3) fail("新窗口 did not open a window for an already open folder");
  const third = workbench()[2];
  if (!third.title.includes("luban-a")) fail(`third window shows ${third.title}`);
  console.log("新窗口按钮:", third.title, portOf(third));
  third.destroy();
  await wait(1500);

  // Opening a folder while a project is on screen must ask, then honour the answer.
  process.env.LUBAN_SMOKE_PICK = folderA;
  process.env.LUBAN_SMOKE_OPEN_MODE = "0";
  await menuItem("打开项目文件夹").click();
  await wait(7000);
  if (workbench().length !== 3) fail("「新窗口打开」did not open a window");
  const chosen = workbench()[2];
  if (!chosen.title.includes("luban-a")) fail(`「新窗口打开」opened ${chosen.title}`);
  console.log("选择新窗口打开:", chosen.title, portOf(chosen));
  chosen.destroy();
  await wait(1500);

  process.env.LUBAN_SMOKE_PICK = folderB;
  process.env.LUBAN_SMOKE_OPEN_MODE = "2";
  await menuItem("打开项目文件夹").click();
  await wait(2500);
  if (workbench().length !== 2) fail("cancel still opened a window");
  console.log("选择取消后窗口数:", workbench().length);

  // The shared media scheme must resolve to the window that named its port.
  const readMedia = async win => (await smoke.protocol.handler(new Request(`luban-media://workspace/clip.mp4?port=${portOf(win)}`))).text();
  const mediaA = await readMedia(first);
  const mediaB = await readMedia(second);
  if (mediaA !== "A" || mediaB !== "B") fail(`media served the wrong workspace: ${mediaA}/${mediaB}`);
  console.log("media per window:", JSON.stringify(mediaA), JSON.stringify(mediaB));

  // Choosing "在当前窗口打开" replaces just that window.
  process.env.LUBAN_SMOKE_PICK = folderC;
  process.env.LUBAN_SMOKE_OPEN_MODE = "1";
  const switched = await smoke.registered.get("luban:openWorkspace")(eventFor(first));
  if (switched.path !== folderC) fail("switch reply lost the folder");
  if (switched.mode !== "switch") fail(`switch reply said ${switched.mode}`);
  delete process.env.LUBAN_SMOKE_OPEN_MODE;
  await wait(7000);
  if (!first.title.includes("luban-c")) fail(`switch did not reload window 1: ${first.title}`);
  if (!second.title.includes("luban-b")) fail(`switch touched the other window: ${second.title}`);
  if (!(await filesOf(first)).includes("c.txt")) fail("switched window cannot see its new folder");
  if (!(await filesOf(second)).includes("b.txt")) fail("other window followed the switch");
  console.log("window 1 after switch:", first.title);

  // Right-click file actions: create, rename, copy path, reveal, trash.
  const createEntry = smoke.registered.get("luban:createEntry");
  const renameEntry = smoke.registered.get("luban:renameEntry");
  const copyPath = smoke.registered.get("luban:copyPath");
  const revealPath = smoke.registered.get("luban:revealPath");
  const trashEntry = smoke.registered.get("luban:trashEntry");
  if (!createEntry || !renameEntry || !copyPath || !revealPath || !trashEntry) fail("file action handlers missing");
  await createEntry(eventFor(first), { path: "notes.md", kind: "file" });
  if (!(await filesOf(first)).includes("notes.md")) fail("新建文件 did not reach the workspace");
  await renameEntry(eventFor(first), { from: "notes.md", to: "readme.md" });
  const renamed = await filesOf(first);
  if (!renamed.includes("readme.md") || renamed.includes("notes.md")) fail(`重命名 did not rename: ${renamed.join(",")}`);
  const copied = await copyPath(eventFor(first), "readme.md");
  if (!copied.path?.endsWith("readme.md")) fail(`复制路径 returned ${JSON.stringify(copied)}`);
  if (!smoke.clipboard.endsWith("readme.md")) fail(`clipboard holds ${JSON.stringify(smoke.clipboard)}`);
  await revealPath(eventFor(first), "readme.md");
  if (!smoke.revealed.at(-1)?.endsWith("readme.md")) fail("在访达中显示 got the wrong path");
  const trashed = await trashEntry(eventFor(first), "readme.md");
  if (!trashed.ok) fail("移到废纸篓 was refused");
  if (!smoke.trashed.at(-1)?.endsWith("readme.md")) fail("trash got the wrong path");
  let escaped = false;
  try { await createEntry(eventFor(first), { path: "../escape.md", kind: "file" }); }
  catch { escaped = true; }
  if (!escaped) fail("a path outside the workspace was created");
  console.log("文件菜单: 新建/重命名/复制路径/显示/废纸篓 ok");

  // A sender that is not a trusted window is rejected.
  let rejected = false;
  try { await listFiles({ sender: { id: 999 }, senderFrame: {} }, undefined); }
  catch { rejected = true; }
  if (!rejected) fail("an untrusted sender was accepted");

  // Closing the second window must not disturb the first.
  second.destroy();
  await wait(1500);
  if (!(await filesOf(first)).includes("c.txt")) fail("first window broke after closing the second");
  console.log("SMOKE OK");
  process.exit(0);
})().catch(error => fail(error.stack || String(error)));
