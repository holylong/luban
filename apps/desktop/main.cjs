const { app, BrowserWindow, dialog, Menu, ipcMain } = require("electron");
const { createWorkspace } = require("./workspace.cjs");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");

const cli = process.env.LUBAN_CLI || resolve(__dirname, "../../dist/cli.js");
const node = process.env.LUBAN_NODE_BIN || "node";
let window;
let backend;
let opening = false;
let workspaceService;
let currentWorkspace;
let trustedOrigin;
let dirty = false;
let approvedUnload = false;

function trustedSender(event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame || !trustedOrigin) return false;
  try { return new URL(event.senderFrame.url).origin === trustedOrigin; }
  catch { return false; }
}
function emitCommand(event) {
  if (!window || window.isDestroyed() || !trustedOrigin) return;
  try {
    if (new URL(window.webContents.getURL()).origin === trustedOrigin) window.webContents.send("luban:commandEvent", event);
  } catch { /* No document during navigation. */ }
}
for (const method of ["readFile", "saveFile", "listFiles", "runCommand", "stopCommand"]) {
  ipcMain.handle(`luban:${method}`, (event, input) => {
    if (!trustedSender(event) || !workspaceService || opening) throw new Error("Untrusted or inactive workspace");
    return workspaceService[method](input);
  });
}
ipcMain.on("luban:setDirty", (event, value) => {
  const allowed = trustedSender(event) && typeof value === "boolean";
  if (allowed) dirty = value;
  event.returnValue = allowed;
});
function confirmDiscard() {
  if (!dirty) return true;
  return dialog.showMessageBoxSync(window, {
    type: "warning", title: "未保存的更改", message: "放弃未保存的更改？",
    buttons: ["取消", "放弃更改"], defaultId: 0, cancelId: 0, noLink: true,
  }) === 1;
}
function stopWorkspace() {
  workspaceService?.dispose();
  workspaceService = undefined;
  trustedOrigin = undefined;
}
function savedWorkspace() {
  try {
    const path = JSON.parse(readFileSync(join(app.getPath("userData"), "workspace.json"), "utf8")).path;
    return typeof path === "string" && existsSync(path) ? path : undefined;
  } catch { return undefined; }
}
function rememberWorkspace(path) {
  writeFileSync(join(app.getPath("userData"), "workspace.json"), JSON.stringify({ path }));
}
function stopBackend() {
  if (!backend) return;
  backend.kill("SIGTERM");
  backend = undefined;
}
function startBackend(workspace) {
  return new Promise((resolveStart, rejectStart) => {
    const token = randomBytes(32).toString("base64url");
    const child = spawn(node, [cli, "web", workspace, "--host", "127.0.0.1", "--port", "0", "--no-mesh"], {
      env: { ...process.env, LUBAN_WEB_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"],
    });
    backend = child;
    let output = "";
    let errors = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`启动本地服务超时：${errors.slice(-500)}`)), 20000);
    function finish(error, url) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGTERM"); rejectStart(error); }
      else resolveStart({ url, token });
    }
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const match = /^luban web (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(output);
      if (match) finish(undefined, match[1]);
      if (output.length > 8192) output = output.slice(-4096);
    });
    child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-4000); });
    child.on("error", error => finish(error));
    child.on("exit", code => {
      if (!settled) finish(new Error(`本地服务退出 (${code})：${errors.slice(-500)}`));
      else if (backend === child && window && !window.isDestroyed()) {
        stopWorkspace();
        dialog.showMessageBox(window, { type: "error", title: "luban", message: "桌面服务已停止", detail: errors.slice(-500) || `退出码 ${code}` });
      }
    });
  });
}
async function chooseWorkspace() {
  const options = { title: "选择项目文件夹", defaultPath: savedWorkspace() || homedir(), properties: ["openDirectory"] };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}
function installWindowGuards() {
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { window = undefined; dirty = false; stopWorkspace(); stopBackend(); });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-prevent-unload", event => {
    if (approvedUnload || confirmDiscard()) {
      dirty = false;
      event.preventDefault(); // Electron: allow unloading despite renderer's veto.
    }
  });
  for (const name of ["will-navigate", "will-redirect"]) {
    window.webContents.on(name, (event, target) => {
      try { if (new URL(target).origin !== trustedOrigin) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
  }
  window.webContents.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame) => {
    if (!isMainFrame) return;
    // Only a committed navigation replaces the service; canceled reloads keep it.
    workspaceService?.dispose();
    workspaceService = undefined;
    dirty = false;
    approvedUnload = false;
    if (trustedOrigin && new URL(url).origin === trustedOrigin) {
      workspaceService = createWorkspace(currentWorkspace, emitCommand);
    }
  });
  window.webContents.on("render-process-gone", () => { dirty = false; stopWorkspace(); });
}
async function openWorkspace(workspace) {
  if (opening || !confirmDiscard()) return;
  opening = true;
  try {
    // Validate the new root before disturbing the old workspace.
    const nextWorkspace = createWorkspace(workspace, emitCommand);
    stopWorkspace();
    stopBackend();
    workspaceService = nextWorkspace;
    currentWorkspace = workspace;
    const { url, token } = await startBackend(workspace);
    rememberWorkspace(workspace);
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        width: 1500, height: 950, minWidth: 920, minHeight: 620,
        show: false, backgroundColor: "#050607",
        icon: join(dirname(cli), "web-ui", process.platform === "win32" ? "icon.ico" : "icon-512.png"),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: join(__dirname, "preload.cjs") },
      });
      installWindowGuards();
    }
    trustedOrigin = new URL(url).origin;
    window.setTitle(`luban · ${basename(workspace)}`);
    approvedUnload = true;
    await window.loadURL(`${url}?desktop=1&token=${encodeURIComponent(token)}`);
    window.show();
  } catch (error) {
    stopWorkspace();
    stopBackend();
    dialog.showErrorBox("无法打开项目", error instanceof Error ? error.message : String(error));
    if (!window) app.quit();
  } finally { opening = false; approvedUnload = false; }
}
app.whenReady().then(async () => {
  app.setName("luban Desktop");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "文件", submenu: [
      { label: "打开项目文件夹…", accelerator: "CmdOrCtrl+O", click: async () => { const path = await chooseWorkspace(); if (path) await openWorkspace(path); } },
      { type: "separator" }, { role: "quit", label: "退出" },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ role: "reload", label: "重新加载" }, { role: "togglefullscreen", label: "全屏" }] },
  ]));
  const argument = process.argv.slice(1)
    .filter(value => !value.startsWith("-"))
    .map(value => resolve(value))
    .filter(value => value !== resolve(app.getAppPath()) && existsSync(value) && statSync(value).isDirectory())
    .at(-1);
  await openWorkspace(argument || savedWorkspace() || homedir());
}).catch(error => { dialog.showErrorBox("luban Desktop", String(error)); app.quit(); });
// before-quit may be canceled by a dirty window; keep its backend alive.
app.on("will-quit", () => { stopWorkspace(); stopBackend(); });
app.on("window-all-closed", () => app.quit());
