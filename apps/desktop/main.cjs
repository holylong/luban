const { app, BrowserWindow, dialog, Menu, ipcMain, screen } = require("electron");
const { preparePetTask } = require("./pet-task.cjs");
const { snapshot: botSnapshot } = require("./bot-host.cjs");
let pet;
let backendAccess;
let petJob;
let petSubmitting = false;
let quitting = false;
// The desktop app is the bot's body: it owns the worker it started, and reports
// a worker owned by a LaunchAgent or a terminal instead of duplicating it.
let botChild;
let botError;
let botQuitting = false;
function showMain() { if (window && !window.isDestroyed()) { window.show(); window.restore(); window.focus(); } }
function trustedPet(event) {
  return pet && !pet.isDestroyed() && event.sender === pet.webContents && event.senderFrame === pet.webContents.mainFrame && event.senderFrame.url === require('node:url').pathToFileURL(join(__dirname, 'pet.html')).href;
}
async function petApi(path, body) {
  if (!backendAccess || opening) throw new Error('工作区尚未就绪');
  const access = backendAccess;
  const response = await fetch(new URL(path, access.url), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${access.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
  if (backendAccess !== access) throw new Error('工作区已切换');
  return result;
}
ipcMain.handle('luban:petOpen', event => { if (!trustedPet(event)) throw new Error('Untrusted pet'); showMain(); });
ipcMain.handle('luban:petSubmit', async (event, input) => {
  if (!trustedPet(event) || petSubmitting) throw new Error('桌宠正在处理提交');
  petSubmitting = true;
  try {
    if (petJob) { const job = await petApi(`/api/jobs/${encodeURIComponent(petJob)}`); if (['queued','pending','working','paused'].includes(job.status)) throw new Error('请先完成或取消当前任务'); }
    const access = backendAccess;
    const task = await preparePetTask(input);
    if (backendAccess !== access || !access) throw new Error('工作区已切换，请重新提交');
    const nodeInfo = await petApi('/api/node');
    const project = Object.entries(nodeInfo.projects || {}).find(([, root]) => root === currentWorkspace)?.[0] || Object.keys(nodeInfo.projects || {})[0];
    if (!project) throw new Error('没有可用项目');
    if (!nodeInfo.interactive) throw new Error('未启用交互审批，拒绝自动执行');
    if (backendAccess !== access) throw new Error('工作区已切换，请重新提交');
    const reply = await petApi('/api/jobs', { ...task, project_id: project, interaction: 'on' });
    petJob = reply.job_id;
    showMain();
    window.webContents.send('luban:petJob', petJob);
    return { id: petJob };
  } finally { petSubmitting = false; }
});
ipcMain.handle('luban:petStatus', async event => {
  if (!trustedPet(event)) throw new Error('Untrusted pet');
  if (!petJob) return { status: 'idle', text: '把任务或文本文件喂给我吧' };
  const job = await petApi(`/api/jobs/${encodeURIComponent(petJob)}`);
  const approvals = await petApi(`/api/approvals?job=${encodeURIComponent(petJob)}`);
  const questions = await petApi(`/api/questions?job=${encodeURIComponent(petJob)}`);
  return { status: approvals.length || questions.length ? 'approval' : job.status, text: job.result || job.error || job.title || '', id: petJob };
});
ipcMain.handle('luban:botStatus', event => {
  if (!trustedPet(event)) throw new Error('Untrusted pet');
  return botSnapshot(botHome(), { owned: Boolean(botChild), error: botError });
});
function createPet() {
  if (pet && !pet.isDestroyed()) { pet.show(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  pet = new BrowserWindow({ width: 330, height: 480, x: area.x + area.width - 350, y: area.y + area.height - 500, frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: join(__dirname, 'pet-preload.cjs') } });
  pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pet.webContents.on('will-navigate', event => event.preventDefault());
  pet.webContents.on('will-redirect', event => event.preventDefault());
  pet.on('closed', () => { pet = undefined; });
  void pet.loadFile(join(__dirname, 'pet.html'));
}
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
for (const method of ["readFile", "saveFile", "listFiles", "runCommand", "stopCommand", "startTerminal", "writeTerminal", "stopTerminal"]) {
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
  backendAccess = undefined;
  petJob = undefined;
  if (!backend) return;
  backend.kill("SIGTERM");
  backend = undefined;
}
function botHome() {
  return process.env.LUBAN_HOME ? resolve(process.env.LUBAN_HOME) : join(homedir(), ".luban");
}
function startBot() {
  if (botChild) return;
  // A worker started by a LaunchAgent or another terminal holds the lock; the
  // pet reports it instead of racing a second worker for the same queue.
  if (existsSync(join(botHome(), "bot", "worker.lock", "pid"))) return;
  botError = undefined;
  let errors = "";
  const child = spawn(node, [cli, "bot", "run"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  botChild = child;
  child.stdout.on("data", chunk => { if (/Bot ready/.test(String(chunk))) botError = undefined; });
  child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-1000); });
  child.on("error", error => { errors = `${errors}${error.message}`.slice(-1000); });
  child.on("exit", code => {
    if (botChild === child) botChild = undefined;
    if (quitting || botQuitting || code === 0) return;
    botError = errors.trim() || `bot 退出 (${code})`;
    if (pet && !pet.isDestroyed()) pet.webContents.send("luban:botChanged");
  });
}
function stopBot() {
  if (!botChild) return;
  const child = botChild;
  botChild = undefined;
  child.kill("SIGTERM");
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
        backendAccess = undefined;
        petJob = undefined;
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
  window.on('close', event => { if (!quitting && pet && !pet.isDestroyed()) { event.preventDefault(); window.hide(); } });
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
  if (opening || petSubmitting || !confirmDiscard()) return;
  opening = true;
  try {
    // Validate the new root before disturbing the old workspace.
    const nextWorkspace = createWorkspace(workspace, emitCommand);
    stopWorkspace();
    stopBackend();
    workspaceService = nextWorkspace;
    currentWorkspace = workspace;
    const { url, token } = await startBackend(workspace);
    backendAccess = { url, token };
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
    { label: "视图", submenu: [{ label: '显示桌宠', click: createPet }, { label: '打开主界面', click: showMain }, { role: "reload", label: "重新加载" }, { role: "togglefullscreen", label: "全屏" }] },
  ]));
  const argument = process.argv.slice(1)
    .filter(value => !value.startsWith("-"))
    .map(value => resolve(value))
    .filter(value => value !== resolve(app.getAppPath()) && existsSync(value) && statSync(value).isDirectory())
    .at(-1);
  await openWorkspace(argument || savedWorkspace() || homedir());
  if (backendAccess) { startBot(); createPet(); }
}).catch(error => { dialog.showErrorBox("luban Desktop", String(error)); app.quit(); });
// before-quit may be canceled by a dirty window; keep its backend alive.
app.on('before-quit', event => {
  quitting = true;
  if (!botChild || botQuitting) return;
  // Let the worker abort its turn and release worker.lock before the app exits,
  // otherwise the next start sees a stale lock left by us.
  event.preventDefault();
  botQuitting = true;
  const child = botChild;
  const finish = () => { botChild = undefined; app.quit(); };
  const timer = setTimeout(finish, 4000);
  child.once('exit', () => { clearTimeout(timer); finish(); });
  child.kill('SIGTERM');
});
app.on("will-quit", () => { stopBot(); stopWorkspace(); stopBackend(); });
app.on("window-all-closed", () => app.quit());
