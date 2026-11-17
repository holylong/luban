const { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, ipcMain, protocol, screen, shell, Tray, globalShortcut } = require("electron");
const { preparePetTask } = require("./pet-task.cjs");
const { chooseNewWorkspace } = require("./new-workspace.cjs");
const { hideForTray } = require("./window-close.cjs");
const { snapshot: botSnapshot } = require("./bot-host.cjs");
let pet;
let petJob;
// The pet submits into one window; remember which so its status keeps working
// after focus moves to another project.
let petSession;
let petSubmitting = false;
let quitting = false;
let tray;
// The desktop app is the bot's body: it owns the worker it started, and reports
// a worker owned by a LaunchAgent or a terminal instead of duplicating it.
let botChild;
let botError;
let botQuitting = false;

// One session per window: its own project root, local backend, workspace
// service and unsaved-changes flag, so two folders can be open at once.
const sessions = new Map();
let lastSession;
let sessionSeq = 0;

function createSession() {
  return {
    key: ++sessionSeq,
    window: undefined,
    workspace: undefined,
    workspaceService: undefined,
    backend: undefined,
    backendAccess: undefined,
    trustedOrigin: undefined,
    dirty: false,
    approvedUnload: false,
    opening: false,
  };
}

function liveSessions() {
  return [...sessions.values()].filter(session => session.window && !session.window.isDestroyed());
}

function focusedSession() {
  const win = BrowserWindow.getFocusedWindow();
  const focused = win && !win.isDestroyed() ? sessions.get(win.webContents.id) : undefined;
  if (focused) return focused;
  if (lastSession && lastSession.window && !lastSession.window.isDestroyed()) return lastSession;
  return liveSessions().at(-1);
}

/** The session behind an IPC event, or undefined when the sender is not ours. */
function trustedSession(event) {
  const session = sessions.get(event.sender.id);
  if (!session || !session.trustedOrigin) return undefined;
  const win = session.window;
  if (!win || win.isDestroyed() || event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame) return undefined;
  try { return new URL(event.senderFrame.url).origin === session.trustedOrigin ? session : undefined; }
  catch { return undefined; }
}

function trustedSender(event) {
  return Boolean(trustedSession(event));
}

function emitCommand(session, event) {
  const win = session.window;
  if (!win || win.isDestroyed() || !session.trustedOrigin) return;
  try {
    if (new URL(win.webContents.getURL()).origin === session.trustedOrigin) win.webContents.send("luban:commandEvent", event);
  } catch { /* No document during navigation. */ }
}

function showSession(session) {
  const win = session && session.window;
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

function showMain() {
  const session = focusedSession();
  if (showSession(session)) return;
  // Closing a window with the tray present only hides it, but a crashed
  // renderer can destroy it; reopen the last project instead of doing nothing.
  if (liveSessions().length || [...sessions.values()].some(item => item.opening)) return;
  void openWorkspaceWindow(savedWorkspace() || homedir())
    .catch(error => dialog.showErrorBox("无法打开项目", error instanceof Error ? error.message : String(error)));
}

function trustedPet(event) {
  return pet && !pet.isDestroyed() && event.sender === pet.webContents && event.senderFrame === pet.webContents.mainFrame && event.senderFrame.url === require('node:url').pathToFileURL(join(__dirname, 'pet.html')).href;
}
async function petApi(session, path, body) {
  const access = session && session.backendAccess;
  if (!access || (session.window && session.window.isDestroyed())) throw new Error('工作区尚未就绪');
  const response = await fetch(new URL(path, access.url), { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${access.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || `HTTP ${response.status}`);
  if (session.backendAccess !== access) throw new Error('工作区已切换');
  return result;
}
ipcMain.handle('luban:petOpen', event => { if (!trustedPet(event)) throw new Error('Untrusted pet'); showMain(); });
ipcMain.handle('luban:petHide', event => { if (!trustedPet(event)) throw new Error('Untrusted pet'); hidePet(); return { ok: true }; });
// The workbench talks about the overlay, not from it, so the main window checks
// the ordinary renderer trust instead of the pet's own document identity.
ipcMain.handle('luban:petVisible', event => { if (!trustedSender(event)) throw new Error('Untrusted renderer'); return petVisible(); });
ipcMain.handle('luban:petToggle', event => { if (!trustedSender(event)) throw new Error('Untrusted renderer'); return togglePet(); });
ipcMain.handle('luban:petSubmit', async (event, input) => {
  if (!trustedPet(event) || petSubmitting) throw new Error('桌宠正在处理提交');
  petSubmitting = true;
  try {
    const session = petSession && petSession.backendAccess ? petSession : focusedSession();
    if (!session || !session.backendAccess) throw new Error('工作区尚未就绪');
    if (petJob) { const job = await petApi(session, `/api/jobs/${encodeURIComponent(petJob)}`); if (['queued','pending','working','paused'].includes(job.status)) throw new Error('请先完成或取消当前任务'); }
    const access = session.backendAccess;
    const task = await preparePetTask(input);
    if (session.backendAccess !== access) throw new Error('工作区已切换，请重新提交');
    const nodeInfo = await petApi(session, '/api/node');
    const project = Object.entries(nodeInfo.projects || {}).find(([, root]) => root === session.workspace)?.[0] || Object.keys(nodeInfo.projects || {})[0];
    if (!project) throw new Error('没有可用项目');
    if (!nodeInfo.interactive) throw new Error('未启用交互审批，拒绝自动执行');
    if (session.backendAccess !== access) throw new Error('工作区已切换，请重新提交');
    const reply = await petApi(session, '/api/jobs', { ...task, project_id: project, interaction: 'on' });
    petJob = reply.job_id;
    petSession = session;
    showSession(session);
    session.window?.webContents.send('luban:petJob', petJob);
    return { id: petJob };
  } finally { petSubmitting = false; }
});
ipcMain.handle('luban:petStatus', async event => {
  if (!trustedPet(event)) throw new Error('Untrusted pet');
  if (!petJob || !petSession || !petSession.backendAccess) return { status: 'idle', text: '把任务或文本文件喂给我吧' };
  const job = await petApi(petSession, `/api/jobs/${encodeURIComponent(petJob)}`);
  const approvals = await petApi(petSession, `/api/approvals?job=${encodeURIComponent(petJob)}`);
  const questions = await petApi(petSession, `/api/questions?job=${encodeURIComponent(petJob)}`);
  return { status: approvals.length || questions.length ? 'approval' : job.status, text: job.result || job.error || job.title || '', id: petJob };
});
ipcMain.handle('luban:botStatus', event => {
  if (!trustedPet(event)) throw new Error('Untrusted pet');
  return botSnapshot(botHome(), { owned: Boolean(botChild), error: botError });
});
function petVisible() {
  return Boolean(pet && !pet.isDestroyed() && pet.isVisible());
}
// The overlay is always on top by design, so the only honest way to stop it
// covering other apps is hiding it. Remembering the choice means a user who hid
// it does not have to hide it again after every restart.
function petPreference() {
  try { return JSON.parse(readFileSync(join(app.getPath("userData"), "pet.json"), "utf8")).visible !== false; }
  catch { return true; }
}
function rememberPet(visible) {
  try { writeFileSync(join(app.getPath("userData"), "pet.json"), JSON.stringify({ visible })); }
  catch { /* A preference is a convenience, never a startup dependency. */ }
}
function announcePet() {
  const visible = petVisible();
  rememberPet(visible);
  if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  for (const session of sessions.values()) {
    const win = session.window;
    if (!win || win.isDestroyed() || !session.trustedOrigin) continue;
    try {
      if (new URL(win.webContents.getURL()).origin === session.trustedOrigin) win.webContents.send('luban:petVisibility', visible);
    } catch { /* No document during navigation. */ }
  }
}
// ── Computer control: edge glow + abort ────────────────────────────────────
// While the agent holds the pointer and keyboard the whole screen rim burns, so
// control is never invisible and ⌘. always takes it back. The backend is a child
// process, so it reports through a loopback endpoint instead of IPC.
let glow;
let glowToken;
let glowServer;
let glowUrl;
const glowLabel = "luban 正在操控";

function glowSend(state) {
  if (!glow || glow.isDestroyed() || glow.webContents.isDestroyed()) return;
  const send = () => glow?.webContents.executeJavaScript(`window.lubanGlow && window.lubanGlow(${JSON.stringify(state)})`).catch(() => undefined);
  // The first state usually arrives while the document is still loading; the
  // rim already animates by default, the badge shows up on finish.
  if (glow.webContents.isLoading()) glow.webContents.once("did-finish-load", () => void send());
  else void send();
}

function createGlow() {
  if (glow && !glow.isDestroyed()) return glow;
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.bounds;
  glow = new BrowserWindow({
    x, y, width, height,
    frame: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false,
    focusable: false, fullscreenable: false, show: false, roundedCorners: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  // A floating panel above full-screen apps, and never in the way of a click.
  glow.setAlwaysOnTop(true, "screen-saver");
  glow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  glow.setIgnoreMouseEvents(true, { forward: true });
  glow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  glow.webContents.on("will-navigate", event => event.preventDefault());
  glow.on("closed", () => { glow = undefined; });
  void glow.loadFile(join(__dirname, "glow.html"));
  return glow;
}

function showGlow(label) {
  const win = createGlow();
  // The agent may be driving a second display, so the rim follows the pointer
  // instead of staying on the display that was active when the window was made.
  const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
  if (win.getBounds().x !== x || win.getBounds().y !== y || win.getBounds().width !== width || win.getBounds().height !== height) {
    win.setBounds({ x, y, width, height });
  }
  glowSend({ mode: "on", label: label || glowLabel });
  if (!win.isVisible()) win.showInactive();
  registerAbortShortcut();
}

function hideGlow() {
  if (!glow || glow.isDestroyed()) return;
  glowSend({ mode: "off" });
  glow.hide();
}

function registerAbortShortcut() {
  if (globalShortcut.isRegistered("CommandOrControl+.")) return;
  // Registered while control is on, released after: ⌘. must reach luban even
  // when the agent is mid-drag.
  globalShortcut.register("CommandOrControl+.", () => { void stopComputerControl(); });
}

async function stopComputerControl() {
  // The flag file is the part that outlives this process: the backend re-reads
  // it before every action, so a running loop aborts at its next step.
  try {
    const dir = join(homedir(), ".luban", "computer");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "stop"), String(Date.now()));
  } catch { /* Best effort: the glow still turns off. */ }
  glowSend({ mode: "stop" });
  setTimeout(() => { hideGlow(); globalShortcut.unregister("CommandOrControl+."); }, 750);
}

/** Loopback endpoint the backend posts begin/action/end to. */
function startGlowServer() {
  if (glowServer) return;
  glowToken = randomBytes(24).toString("base64url");
  const http = require("node:http");
  glowServer = http.createServer((request, response) => {
    const finish = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST") return finish(405, { ok: false });
    if (request.headers["x-luban-glow-token"] !== glowToken) return finish(401, { ok: false });
    let body = "";
    request.on("data", chunk => { body += chunk; if (body.length > 8192) request.destroy(); });
    request.on("end", () => {
      let event = {};
      try { event = JSON.parse(body || "{}"); } catch { return finish(400, { ok: false }); }
      // Authorization is not activity; only actual operations light the rim.
      if (event.event === "action") {
        if (!glow || glow.isDestroyed() || !glow.isVisible()) showGlow(event.label);
        else glowSend({ mode: "action", label: event.label || glowLabel });
      } else if (event.event === "end") hideGlow();
      finish(200, { ok: true });
    });
  });
  glowServer.listen(0, "127.0.0.1", () => {
    glowUrl = `http://127.0.0.1:${glowServer.address().port}/glow`;
  });
  glowServer.unref?.();
}

function createPet() {
  if (pet && !pet.isDestroyed()) { pet.show(); pet.focus(); announcePet(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  pet = new BrowserWindow({ width: 330, height: 480, x: area.x + area.width - 350, y: area.y + area.height - 500, frame: false, transparent: true, alwaysOnTop: true, resizable: false, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, preload: join(__dirname, 'pet-preload.cjs') } });
  pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pet.webContents.on('will-navigate', event => event.preventDefault());
  pet.webContents.on('will-redirect', event => event.preventDefault());
  pet.on('closed', () => { pet = undefined; announcePet(); });
  pet.on('show', () => announcePet());
  pet.on('hide', () => announcePet());
  void pet.loadFile(join(__dirname, 'pet.html'));
  announcePet();
}
function hidePet() {
  if (pet && !pet.isDestroyed()) pet.hide();
  announcePet();
}
/** One switch for the workbench button, the tray item and the View menu. */
function togglePet() {
  if (petVisible()) hidePet();
  else createPet();
  return petVisible();
}
// The window hides itself instead of closing and the pet has no frame, so the
// tray is the dependable place to reopen luban and to quit it for good.
function trayImage() {
  const webUi = join(dirname(cli), "web-ui");
  const bundled = join(webUi, process.platform === "win32" ? "icon.ico" : "icon-512.png");
  const fallback = resolve(__dirname, "../../assets", process.platform === "win32" ? "luban.ico" : "luban-32.png");
  const image = nativeImage.createFromPath(existsSync(bundled) ? bundled : fallback);
  if (process.platform === "win32") return image;
  // macOS and Linux panels want a small square; an ICO carries its own sizes.
  const size = process.platform === "darwin" ? 18 : 22;
  return image.resize({ width: size, height: size });
}
function trayTooltip() {
  const session = focusedSession();
  return `luban${session?.workspace ? ` · ${basename(session.workspace)}` : ""}`;
}
function quitApp() {
  // The tray may be the only visible surface; surface a window first so an
  // "放弃未保存的更改？" prompt is not parented to a hidden window.
  if (dirtySessions().length) showMain();
  app.quit();
}
function dirtySessions() {
  return liveSessions().filter(session => session.dirty);
}
function trayTemplate() {
  return [
    { label: "打开主界面", click: showMain },
    { label: petVisible() ? "隐藏桌宠" : "显示桌宠", click: togglePet },
    { type: "separator" },
    { label: "新建窗口", click: () => { void newWindow().catch(reportOpenError); } },
    { label: "打开项目文件夹…", click: async () => { const path = await chooseWorkspace(); if (path) await openFolder(path).catch(reportOpenError); } },
    { label: "新建工作区…", click: async () => { const path = await createWorkspaceFolder(focusedSession()); if (path) await openFolder(path).catch(reportOpenError); } },
    { type: "separator" },
    { label: "退出 luban", click: quitApp },
  ];
}
function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  // A desktop environment without a status bar must not stop luban from opening.
  try { tray = new Tray(trayImage()); }
  catch { tray = undefined; return undefined; }
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
  // A single click is what Windows users try first; macOS opens the menu itself.
  tray.on("click", showMain);
  tray.on("double-click", showMain);
  return tray;
}
function updateTray() {
  if (!tray || tray.isDestroyed()) return;
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));
}
const { createWorkspace } = require("./workspace.cjs");
const { MEDIA_SCHEME, mediaResponse } = require("./media.cjs");

// Media previews stream a workspace file to <video>, <audio> and <img>. A
// privileged scheme keeps the renderer sandboxed: it can only name files the
// workspace service resolves inside the project root.
protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { basename, dirname, join, resolve } = require("node:path");

const cli = process.env.LUBAN_CLI || resolve(__dirname, "../../dist/cli.js");
const node = process.env.LUBAN_NODE_BIN || "node";

for (const method of ["readFile", "saveFile", "listFiles", "readPreview", "createEntry", "renameEntry", "runCommand", "stopCommand", "startTerminal", "writeTerminal", "resizeTerminal", "stopTerminal"]) {
  ipcMain.handle(`luban:${method}`, (event, input) => {
    const session = trustedSession(event);
    if (!session || !session.workspaceService || session.opening) throw new Error("Untrusted or inactive workspace");
    return session.workspaceService[method](input);
  });
}
// Formats the preview cannot paint (a PDF the user wants to annotate, a deck to
// edit) still open in the application the OS associates with them.
ipcMain.handle("luban:openPath", async (event, value) => {
  const session = trustedSession(event);
  if (!session || !session.workspaceService || session.opening) throw new Error("Untrusted or inactive workspace");
  const error = await shell.openPath(session.workspaceService.absolutePath(value));
  if (error) throw new Error(error);
  return { ok: true };
});
ipcMain.handle("luban:openExternal", async (event, value) => {
  const session = trustedSession(event);
  if (!session || session.opening) throw new Error("Untrusted or inactive workspace");
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) throw new Error("Only HTTP(S) links are supported");
  const url = new URL(value);
  await shell.openExternal(url.href);
  return { ok: true };
});
// File-tree actions from the renderer. Each one resolves the path through the
// workspace service first, so a crafted IPC message cannot reach outside it.
ipcMain.handle("luban:revealPath", (event, value) => {
  const session = trustedSession(event);
  if (!session || !session.workspaceService || session.opening) throw new Error("Untrusted or inactive workspace");
  shell.showItemInFolder(session.workspaceService.absolutePath(value));
  return { ok: true };
});
ipcMain.handle("luban:copyPath", (event, value) => {
  const session = trustedSession(event);
  if (!session || !session.workspaceService || session.opening) throw new Error("Untrusted or inactive workspace");
  const absolute = session.workspaceService.absolutePath(value);
  clipboard.writeText(absolute);
  return { ok: true, path: absolute };
});
ipcMain.handle("luban:trashEntry", async (event, value) => {
  const session = trustedSession(event);
  if (!session || !session.workspaceService || session.opening) throw new Error("Untrusted or inactive workspace");
  const absolute = session.workspaceService.absolutePath(value);
  const win = session.window;
  const answer = dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: "warning", title: "移到废纸篓", message: `把「${value}」移到废纸篓？`,
    buttons: ["取消", "移到废纸篓"], defaultId: 0, cancelId: 0, noLink: true,
  });
  if (answer !== 1) return { ok: false, canceled: true };
  await shell.trashItem(absolute);
  return { ok: true };
});
ipcMain.on("luban:setDirty", (event, value) => {
  const session = trustedSession(event);
  const allowed = Boolean(session) && typeof value === "boolean";
  if (allowed) session.dirty = value;
  event.returnValue = allowed;
});
function confirmDiscard(session) {
  if (!session.dirty) return true;
  const win = session.window;
  // A modal prompt parented to a window hidden in the tray never shows up.
  if (win && !win.isDestroyed()) win.show();
  return dialog.showMessageBoxSync(win && !win.isDestroyed() ? win : undefined, {
    type: "warning", title: "未保存的更改", message: "放弃未保存的更改？",
    buttons: ["取消", "放弃更改"], defaultId: 0, cancelId: 0, noLink: true,
  }) === 1;
}
function stopWorkspace(session) {
  session.workspaceService?.dispose();
  session.workspaceService = undefined;
  session.trustedOrigin = undefined;
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
function stopBackend(session) {
  if (petSession === session) { petJob = undefined; petSession = undefined; }
  session.backendAccess = undefined;
  if (!session.backend) return;
  session.backend.kill("SIGTERM");
  session.backend = undefined;
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
/**
 * Ask the per-machine daemon to hold this folder open for the phone.
 *
 * The window's own backend dies with the app, so it must not be the thing the
 * phone depends on. `luban daemon start` is idempotent: the first call starts a
 * detached server, later calls only add the folder to the project list.
 */
function ensureDaemonFor(workspace) {
  try {
    const child = spawn(node, [cli, "daemon", "start", workspace], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // A missing phone link must never stop a desktop window from opening.
  }
}
function startBackend(session, workspace) {
  return new Promise((resolveStart, rejectStart) => {
    const token = randomBytes(32).toString("base64url");
    // The window talks to a loopback-only backend, and --parent-pid makes it die
    // with the app. The relay slot belongs to the daemon instead (see
    // ensureDaemonFor): one device can only hold one slot, and the phone must
    // keep reaching this machine after the app is closed.
    const args = [cli, "web", workspace, "--host", "127.0.0.1", "--port", "0", "--no-mesh",
      "--parent-pid", String(process.pid)];
    const child = spawn(node, args, {
      env: {
        ...process.env,
        LUBAN_WEB_TOKEN: token,
        ...(glowUrl ? { LUBAN_GLOW_URL: glowUrl, LUBAN_GLOW_TOKEN: glowToken } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.backend = child;
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
      else if (session.backend === child && session.window && !session.window.isDestroyed()) {
        stopWorkspace(session);
        stopBackend(session);
        showSession(session);
        dialog.showMessageBox(session.window, { type: "error", title: "luban", message: "桌面服务已停止", detail: errors.slice(-500) || `退出码 ${code}` });
      }
    });
  });
}
async function chooseWorkspace(session) {
  const win = session && session.window && !session.window.isDestroyed() ? session.window : undefined;
  const options = { title: "选择项目文件夹", defaultPath: session?.workspace || savedWorkspace() || homedir(), properties: ["openDirectory"] };
  // The tray can ask for a folder while every window is hidden behind it.
  if (win) win.show();
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? undefined : result.filePaths[0];
}
/** Ask for a name and location, then create the folder. Returns undefined when
 * the user cancels; the caller decides which window opens the new root. */
async function createWorkspaceFolder(session) {
  const win = session && session.window && !session.window.isDestroyed() ? session.window : undefined;
  if (win) win.show();
  return chooseNewWorkspace(dialog, win, session?.workspace || savedWorkspace() || homedir());
}
function reportOpenError(error) {
  dialog.showErrorBox("无法打开项目", error instanceof Error ? error.message : String(error));
}
/**
 * Opening another folder while a project is already on screen is ambiguous, so
 * the user picks: a second window (the current project keeps running) or this
 * window (its project is replaced). Returns "window", "switch" or "cancel".
 */
async function askOpenMode(session, workspace) {
  if (!session?.workspace) return "switch";
  const options = {
    type: "question", title: "打开项目", message: `打开「${basename(workspace)}」`,
    detail: `当前窗口打开的是「${basename(session.workspace)}」。新窗口打开可以让它继续运行；在当前窗口打开会关掉它的后端并换成新文件夹。`,
    buttons: ["新窗口打开", "在当前窗口打开", "取消"], defaultId: 0, cancelId: 2, noLink: true,
  };
  const win = session.window && !session.window.isDestroyed() ? session.window : undefined;
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 0 ? "window" : response === 1 ? "switch" : "cancel";
}
function findWindowFor(workspace) {
  const target = resolve(workspace);
  return liveSessions().find(session => session.workspace && resolve(session.workspace) === target && !session.opening);
}
// The window's own project dropdown is disabled in desktop mode (the backend is
// pinned to one root), so the renderer needs a way to reach the same folder
// picker and workspace creator as the File menu instead of making the native
// menu the only path.
ipcMain.handle("luban:createWorkspace", event => pickAndOpenWorkspace(event, true));
ipcMain.handle("luban:openWorkspace", event => pickAndOpenWorkspace(event));
async function pickAndOpenWorkspace(event, create = false) {
  const session = trustedSession(event);
  if (!session || session.opening || petSubmitting) throw new Error("当前无法切换工作区");
  const target = create ? await createWorkspaceFolder(session) : await chooseWorkspace(session);
  if (!target) return { canceled: true };
  const mode = await askOpenMode(session, target);
  if (mode === "cancel") return { canceled: true };
  // Reply first: switching replaces this document, so a later reply would be
  // dropped with the renderer that is waiting for it.
  setImmediate(() => {
    (mode === "switch" ? loadInSession(session, target) : openWorkspaceWindow(target)).catch(reportOpenError);
  });
  return { path: target, mode };
}
// The multi-window path: the current project keeps running in its own window.
ipcMain.handle("luban:openWorkspaceWindow", async event => {
  const session = trustedSession(event);
  if (!session || petSubmitting) throw new Error("当前无法打开窗口");
  const target = await chooseWorkspace(session);
  if (!target) return { canceled: true };
  // A new window is the point of this action, so a folder that is already open
  // elsewhere gets its own window too instead of silently focusing the old one.
  setImmediate(() => { openWorkspaceWindow(target).catch(reportOpenError); });
  return { path: target };
});
function installWindowGuards(session) {
  const win = session.window;
  // Electron normally replaces BrowserWindow's title with the renderer's <title>
  // after navigation. All desktop windows load the same generic HTML title, which
  // makes macOS's Dock/window list impossible to distinguish. Keep the project
  // and this window's stable session number as the native title instead.
  win.webContents.on("page-title-updated", event => {
    event.preventDefault();
    setWorkspaceWindowTitle(session);
  });
  win.once("ready-to-show", () => win.show());
  win.on("focus", () => { lastSession = session; updateTray(); });
  // Closing hides the window: its backend keeps running and the tray icon
  // reopens it. Without a usable tray the close stays a real one. A full-screen
  // window must leave full screen first, or its Space stays occupied and black.
  win.on('close', event => { if (!quitting && tray && !tray.isDestroyed()) { event.preventDefault(); hideForTray(win); } });
  win.on("closed", () => {
    // The webContents is already gone here, so the id was captured at creation.
    if (session.webContentsId) sessions.delete(session.webContentsId);
    session.webContentsId = undefined;
    session.window = undefined;
    session.dirty = false;
    stopWorkspace(session);
    stopBackend(session);
    if (lastSession === session) lastSession = undefined;
    updateTray();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-prevent-unload", event => {
    if (session.approvedUnload || confirmDiscard(session)) {
      session.dirty = false;
      event.preventDefault(); // Electron: allow unloading despite renderer's veto.
    }
  });
  for (const name of ["will-navigate", "will-redirect"]) {
    win.webContents.on(name, (event, target) => {
      try { if (new URL(target).origin !== session.trustedOrigin) event.preventDefault(); }
      catch { event.preventDefault(); }
    });
  }
  win.webContents.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame) => {
    if (!isMainFrame) return;
    // Only a committed navigation replaces the service; canceled reloads keep it.
    session.workspaceService?.dispose();
    session.workspaceService = undefined;
    session.dirty = false;
    session.approvedUnload = false;
    if (session.trustedOrigin && new URL(url).origin === session.trustedOrigin) {
      session.workspaceService = createWorkspace(session.workspace, event => emitCommand(session, event));
    }
  });
  win.webContents.on("render-process-gone", () => { session.dirty = false; stopWorkspace(session); });
}
function setWorkspaceWindowTitle(session) {
  const win = session.window;
  if (!win || win.isDestroyed()) return;
  const project = session.workspace ? basename(session.workspace) : "Workspace";
  win.setTitle(`luban · ${project} — 窗口 ${session.key}`);
}
function ensureWindow(session) {
  if (session.window && !session.window.isDestroyed()) return session.window;
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 920, minHeight: 620,
    show: false, backgroundColor: "#050607",
    icon: join(dirname(cli), "web-ui", process.platform === "win32" ? "icon.ico" : "icon-512.png"),
    // plugins:true is what enables Chromium's bundled PDF viewer for the
    // luban-media:// embed, so a PDF preview needs no external application.
    // Cookies are host-scoped, not port-scoped: sharing Electron's default
    // session lets a second loopback backend overwrite the first one's token.
    // A private, in-memory partition keeps lazy imports, fetch and SSE attached
    // to this window's backend, without persisting credentials between launches.
    webPreferences: { partition: `luban-workspace-${session.key}`, nodeIntegration: false, contextIsolation: true, sandbox: true, plugins: true, preload: join(__dirname, "preload.cjs") },
  });
  session.window = win;
  // Protocol handlers are session-scoped. These windows deliberately use private
  // partitions, so registering on Electron's default protocol does not reach
  // PDF embeds (or any other workspace media) in this window.
  win.webContents.session.protocol.handle(MEDIA_SCHEME, request => {
    if (!session.workspaceService) return new Response("工作区尚未就绪", { status: 503 });
    try { return mediaResponse(session.workspaceService, request); }
    catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 500 }); }
  });
  // Keep credentials in the main process, independent of expiring/lost cookies.
  // Read current access per request so project switches rotate the credential.
  win.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
    const access = session.backendAccess;
    const headers = { ...details.requestHeaders };
    if (access && new URL(details.url).origin === new URL(access.url).origin) {
      headers["x-luban-token"] = access.token;
    }
    callback({ requestHeaders: headers });
  });
  session.webContentsId = win.webContents.id;
  sessions.set(session.webContentsId, session);
  installWindowGuards(session);
  return win;
}
/** Load a project into one window, replacing whatever that window showed. */
async function loadInSession(session, workspace) {
  if (session.opening) return;
  if (!confirmDiscard(session)) throw new Error("已取消：这个窗口有未保存的更改");
  const hadWorkspace = Boolean(session.workspace);
  session.opening = true;
  try {
    // Validate the new root before disturbing the old workspace.
    const nextWorkspace = createWorkspace(workspace, event => emitCommand(session, event));
    stopWorkspace(session);
    stopBackend(session);
    session.workspaceService = nextWorkspace;
    session.workspace = workspace;
    const { url, token } = await startBackend(session, workspace);
    session.backendAccess = { url, token };
    session.trustedOrigin = new URL(url).origin;
    rememberWorkspace(workspace);
    const win = ensureWindow(session);
    setWorkspaceWindowTitle(session);
    updateTray();
    session.approvedUnload = true;
    await win.loadURL(`${url}?desktop=1&token=${encodeURIComponent(token)}`);
    win.show();
  } catch (error) {
    stopWorkspace(session);
    stopBackend(session);
    // A window that never showed a project should not linger empty.
    if (!hadWorkspace && session.window && !session.window.isDestroyed()) session.window.destroy();
    throw error;
  } finally {
    session.opening = false;
    session.approvedUnload = false;
  }
}
/** Open a project in a brand new window and focus it. */
async function openWorkspaceWindow(workspace) {
  if (!process.env.LUBAN_NO_DAEMON) ensureDaemonFor(workspace);
  const session = createSession();
  try {
    await loadInSession(session, workspace);
  } catch (error) {
    if (session.webContentsId) sessions.delete(session.webContentsId);
    if (!liveSessions().length) throw error;
    reportOpenError(error);
  }
  showSession(session);
  return session;
}
/**
 * 文件 → 打开项目文件夹: reuse a window that already shows this folder, otherwise
 * open a second window so the current project keeps running.
 */
async function newWindow() {
  const source = focusedSession();
  return openWorkspaceWindow(source?.workspace || savedWorkspace() || homedir());
}
async function openFolder(workspace) {
  const source = focusedSession();
  const mode = await askOpenMode(source, workspace);
  if (mode === "cancel") return;
  if (mode === "switch") { await loadInSession(source ?? createSession(), workspace); return; }
  await openWorkspaceWindow(workspace);
}
/** The media scheme is shared by every window, so the URL names its backend. */
function mediaSession(request) {
  try {
    const port = new URL(request.url).searchParams.get("port");
    if (port) {
      const owner = [...sessions.values()].find(session => {
        try { return session.backendAccess && new URL(session.backendAccess.url).port === port; }
        catch { return false; }
      });
      if (owner) return owner;
    }
  } catch { /* A malformed URL falls through to the focused window. */ }
  return focusedSession();
}
function folderFromArgs(argv) {
  return argv.slice(1)
    .filter(value => !value.startsWith("-"))
    .map(value => resolve(value))
    .filter(value => value !== resolve(app.getAppPath()) && existsSync(value) && statSync(value).isDirectory())
    .at(-1);
}
// Launching luban again, or opening a folder with it, belongs to the running
// app: a second process would race for the relay slot and the bot worker.
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", (_event, argv) => {
  const folder = folderFromArgs(argv);
  if (!folder) { showMain(); return; }
  const existing = findWindowFor(folder);
  if (existing) { showSession(existing); return; }
  void openFolder(folder).catch(reportOpenError);
});
app.whenReady().then(async () => {
  app.setName("luban");
  // Create the tray before the workspace opens so an unopenable project still
  // has a visible way out (退出 luban) instead of an invisible process.
  createTray();
  protocol.handle(MEDIA_SCHEME, request => {
    try {
      const session = mediaSession(request);
      if (!session?.workspaceService) return new Response("工作区尚未就绪", { status: 503 });
      return mediaResponse(session.workspaceService, request);
    }
    catch (error) { return new Response(error instanceof Error ? error.message : String(error), { status: 500 }); }
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "文件", submenu: [
      { label: "打开项目文件夹…", accelerator: "CmdOrCtrl+O", click: async () => { const path = await chooseWorkspace(focusedSession()); if (path) await openFolder(path).catch(reportOpenError); } },
      { label: "新建工作区…", click: async () => { const path = await createWorkspaceFolder(focusedSession()); if (path) await openFolder(path).catch(reportOpenError); } },
      { label: "新建窗口", accelerator: "CmdOrCtrl+Shift+N", click: () => { void newWindow().catch(reportOpenError); } },
      { label: "隐藏到托盘", click: () => { const session = focusedSession(); if (session?.window) hideForTray(session.window); } },
      { type: "separator" }, { role: "quit", label: "退出" },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "视图", submenu: [{ label: '显示桌宠', click: createPet }, { label: "停止电脑操控", click: () => { void stopComputerControl(); } }, { label: '打开主界面', click: showMain }, { role: "reload", label: "重新加载" }, { role: "togglefullscreen", label: "全屏" }] },
  ]));
  startGlowServer();
  await openWorkspaceWindow(folderFromArgs(process.argv) || savedWorkspace() || homedir());
  if (liveSessions().some(session => session.backendAccess)) { startBot(); if (petPreference()) createPet(); }
}).catch(error => { dialog.showErrorBox("luban", String(error)); app.quit(); });
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
app.on("activate", showMain);
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (glowServer) { glowServer.close(); glowServer = undefined; }
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = undefined;
  stopBot();
  for (const session of sessions.values()) { stopWorkspace(session); stopBackend(session); }
  sessions.clear();
});
// The tray keeps luban (and the bot worker) alive with no window; a close
// without a usable tray still quits, since nothing could reopen the app.
app.on("window-all-closed", () => { if (!tray || tray.isDestroyed()) app.quit(); });
