/**
 * 造物主 — the standalone, always-resident creator app.
 *
 * It is deliberately *not* the workbench: no project, no editor, no browser
 * preview. It owns one thing — the durable task queue in ~/.luban/bot — and a
 * menu-bar entry that pops its window. The serial worker behind the queue is a
 * separate process (`luban bot run`), so this app can be closed, restarted or
 * crashed without losing a running task.
 *
 *   npm run build && npm run creator
 */
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require("electron");
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");

const bot = require("./bot.cjs");

const home = bot.homeDir();
const dataDirectory = join(home, "bot");
/** `--smoke <png>`: render one window, save a screenshot, exit. */
const smokeIndex = process.argv.indexOf("--smoke");
const smokePath = smokeIndex > 0 ? process.argv[smokeIndex + 1] : undefined;

let win;
let tray;
let quitting = false;

function webUi() {
  return join(dirname(bot.cliPath()), "web-ui");
}

function snapshot() {
  return {
    home,
    policy: bot.policyPath(home),
    data: dataDirectory,
    now: Date.now(),
    worker: bot.workerStatus(home),
    tasks: bot.listTasks(home),
    requests: bot.permissionRequests(home),
  };
}

function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
  const page = join(webUi(), "creator.html");
  win = new BrowserWindow({
    width: 460, height: 700, minWidth: 380, minHeight: 460,
    show: false, backgroundColor: "#0b0d11", title: "造物主",
    // A popover, not a document window: the traffic lights sit in the header row.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: join(__dirname, "preload.cjs"),
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  // Closing the window hides the app: the tray is the resident surface.
  win.on("close", event => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  if (!existsSync(page)) {
    void dialog.showMessageBox({ message: "缺少界面文件", detail: `${page}\n\n先执行 npm run build`, buttons: ["好"] });
  }
  void win.loadFile(page);
  win.once("ready-to-show", () => { if (!smokePath) win.show(); });
  return win;
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  else createWindow();
}

function createTray() {
  // Text-only status item: no icon asset to ship, and it stays legible in both
  // menu-bar appearances on macOS.
  tray = new Tray(nativeImage.createEmpty());
  if (process.platform === "darwin") tray.setTitle("造物主");
  else tray.setToolTip("造物主");
  tray.on("click", toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开造物主", click: () => createWindow() },
    { label: "让后台开始干活", click: () => { bot.ensureWorker(home); refreshTray(); } },
    { type: "separator" },
    { label: "打开任务数据目录", click: () => { void shell.openPath(dataDirectory); } },
    { label: "允许的工具（permissions.json）", click: () => { void openPolicyFile(); } },
    { type: "separator" },
    { label: "退出造物主（后台任务继续）", click: () => { quitting = true; app.quit(); } },
  ]));
  refreshTray();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const status = bot.workerStatus(home);
  const label = status.running ? (status.task ? "造物主 · 忙" : "造物主 · 待命") : "造物主 · 未启动";
  if (process.platform === "darwin") tray.setTitle(label.replace("造物主 · ", ""));
  tray.setToolTip(`造物主 — ${label}`);
}

async function openPolicyFile() {
  const path = bot.policyPath(home);
  if (!existsSync(path)) {
    // Creating it is `luban bot permissions`; do that rather than invent a file.
    await bot.ensurePolicy(home).catch(() => undefined);
  }
  const error = await shell.openPath(path);
  if (error) void dialog.showMessageBox({ message: "打不开 permissions.json", detail: error, buttons: ["好"] });
}

ipcMain.handle("creator:snapshot", () => snapshot());
ipcMain.handle("creator:add", (_event, input) => {
  const result = bot.addTask(home, input || {});
  // Submitting from the window is a clear signal that work should start now.
  bot.ensureWorker(home);
  refreshTray();
  return { ...result, snapshot: snapshot() };
});
ipcMain.handle("creator:cancel", (_event, id) => {
  bot.cancelTask(home, id);
  refreshTray();
  return snapshot();
});
ipcMain.handle("creator:startWorker", () => {
  const result = bot.ensureWorker(home);
  refreshTray();
  return { ...result, snapshot: snapshot() };
});
ipcMain.handle("creator:pickWorkspace", async () => {
  const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "选择造物主的工作区" });
  return picked.canceled ? undefined : picked.filePaths[0];
});
ipcMain.handle("creator:openPolicy", async () => { await openPolicyFile(); return { ok: true }; });
ipcMain.handle("creator:openData", async () => { await shell.openPath(dataDirectory); return { ok: true }; });
ipcMain.handle("creator:hide", () => { win?.hide(); return { ok: true }; });

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => createWindow());
  app.whenReady().then(async () => {
    if (process.platform === "darwin" && app.dock) app.dock.hide();
    createTray();
    const window = createWindow();
    // The resident promise: opening the app means the queue is being drained.
    // A screenshot run must never start a worker that spends tokens.
    if (!smokePath) bot.ensureWorker(home);
    if (smokePath) {
      window.webContents.once("did-finish-load", () => {
        setTimeout(async () => {
          const image = await window.webContents.capturePage();
          require("node:fs").writeFileSync(smokePath, image.toPNG());
          // Text beside the pixels: a screenshot proves it painted, not what it said.
          const text = await window.webContents.executeJavaScript("document.body.innerText");
          require("node:fs").writeFileSync(smokePath.replace(/\.png$/u, ".txt"), String(text));
          quitting = true;
          app.quit();
        }, 1200);
      });
    }
    setInterval(refreshTray, 5000).unref?.();
  });
  // macOS keeps the process alive without windows; that is the point.
  app.on("window-all-closed", () => undefined);
  app.on("activate", () => createWindow());
  app.on("before-quit", () => { quitting = true; });
}
