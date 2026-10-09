const { app, BrowserWindow, dialog, Menu } = require("electron");
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
      env: { ...process.env, LUBAN_WEB_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"],
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
        dialog.showMessageBox(window, { type: "error", title: "luban", message: "桌面服务已停止", detail: errors.slice(-500) || `退出码 ${code}` });
      }
    });
  });
}

async function chooseWorkspace() {
  const options = {
    title: "选择项目文件夹",
    defaultPath: savedWorkspace() || homedir(),
    properties: ["openDirectory"],
  };
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}

async function openWorkspace(workspace) {
  if (opening) return;
  opening = true;
  try {
    stopBackend();
    const { url, token } = await startBackend(workspace);
    rememberWorkspace(workspace);
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        width: 1500, height: 950, minWidth: 920, minHeight: 620,
        show: false, backgroundColor: "#050607",
        icon: join(dirname(cli), "web-ui", process.platform === "win32" ? "icon.ico" : "icon-512.png"),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
      });
      window.once("ready-to-show", () => window.show());
      window.on("closed", () => { window = undefined; stopBackend(); });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    }
    const origin = new URL(url).origin;
    window.webContents.removeAllListeners("will-navigate");
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== origin) event.preventDefault();
    });
    window.setTitle(`luban · ${basename(workspace)}`);
    await window.loadURL(`${url}?desktop=1&token=${encodeURIComponent(token)}`);
    window.show();
  } catch (error) {
    dialog.showErrorBox("无法打开项目", error instanceof Error ? error.message : String(error));
    if (!window) app.quit();
  } finally { opening = false; }
}

app.whenReady().then(async () => {
  app.setName("luban Desktop");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "文件", submenu: [
      { label: "打开项目文件夹…", accelerator: "CmdOrCtrl+O", click: async () => { const path = await chooseWorkspace(); if (path) await openWorkspace(path); } },
      { type: "separator" },
      { role: "quit", label: "退出" },
    ] },
    { label: "视图", submenu: [{ role: "reload", label: "重新加载" }, { role: "togglefullscreen", label: "全屏" }] },
  ]));
  const argument = process.argv.slice(1)
    .filter(value => !value.startsWith("-"))
    .map(value => resolve(value))
    .filter(value => value !== resolve(app.getAppPath()) && existsSync(value) && statSync(value).isDirectory())
    .at(-1);
  await openWorkspace(argument || savedWorkspace() || homedir());
}).catch(error => { dialog.showErrorBox("luban Desktop", String(error)); app.quit(); });

app.on("before-quit", stopBackend);
app.on("window-all-closed", () => app.quit());
