/**
 * Creator — the standalone, always-resident creator app.
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
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname, isAbsolute, join, resolve } = require("node:path");

const bot = require("./bot.cjs");
const { DriveBridge, rememberApproval } = require("./drive.cjs");

const home = bot.homeDir();
const dataDirectory = join(home, "bot");
/** `--smoke <png>`: render one window, save a screenshot, exit. */
const smokeIndex = process.argv.indexOf("--smoke");
const smokePath = smokeIndex > 0 ? process.argv[smokeIndex + 1] : undefined;

let win;
let tray;
let quitting = false;
let drive;
/** Persisted 电脑操控 switch and standing 允许 list: the window may be closed and reopened mid-session. */
let settings = { computer: false, allowed: [] };
/** Approval ids still on screen, so a 允许 can be remembered by tool name. */
const pendingApprovals = new Map();

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

function settingsPath() {
  return join(home, "creator.json");
}

function loadSettings() {
  try {
    const stored = JSON.parse(readFileSync(settingsPath(), "utf8"));
    settings = {
      computer: stored?.computer === true,
      allowed: Array.isArray(stored?.allowed) ? stored.allowed.filter(name => typeof name === "string" && name) : [],
    };
  } catch { settings = { computer: false, allowed: [] }; }
  return settings;
}

function saveSettings() {
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch { /* a lost preference is not worth blocking the window */ }
}

/**
 * Screenshots come back as paths; the renderer is sandboxed and cannot read
 * files, so the thumbnail is inlined here. 520px wide is enough to recognise a
 * window and small enough not to bloat every event.
 */
function thumbnail(path) {
  try {
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) return undefined;
    const size = image.getSize();
    const width = Math.min(520, size.width || 520);
    const resized = width < size.width ? image.resize({ width }) : image;
    return `data:image/png;base64,${resized.toPNG().toString("base64")}`;
  } catch { return undefined; }
}

/** The child's stderr, kept beside the queue so a failed turn can be read later. */
function logPath() {
  return join(dataDirectory, "drive.log");
}

function appendLog(line) {
  try {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    const path = logPath();
    const size = existsSync(path) ? require("node:fs").statSync(path).size : 0;
    if (size > 2 * 1024 * 1024) writeFileSync(path, "", { mode: 0o600 });
    require("node:fs").appendFileSync(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  } catch { /* logging must never take the turn down */ }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function ensureDrive() {
  if (drive) return drive;
  drive = new DriveBridge({
    onEvent: event => {
      // The session reports paths relative to its workspace; the window's own
      // cwd is elsewhere, and a relative path there is simply a missing file.
      const shotPath = event.screenshot
        ? (isAbsolute(event.screenshot) ? event.screenshot : resolve(drive.workspace || home, event.screenshot))
        : "";
      const forwarded = event.type === "tool-result" && shotPath
        ? { ...event, image: thumbnail(shotPath) }
        : event;
      // A 允许 answers this prompt and every later one for the same tool: the
      // window records the tool name, and the next session starts with it.
      if (event.type === "approval" && event.id) pendingApprovals.set(event.id, event.tool);
      if (event.type === "approval-settled" && event.id) {
        const tool = pendingApprovals.get(event.id);
        pendingApprovals.delete(event.id);
        if (tool) {
          const next = rememberApproval(settings.allowed, tool, event.allow === true);
          if (next.join(",") !== settings.allowed.join(",")) {
            settings = { ...settings, allowed: next };
            saveSettings();
            send("creator:settings", settings);
          }
        }
      }
      if (event.type === "exit") pendingApprovals.clear();
      send("creator:drive-event", forwarded);
    },
    onLog: line => { if (line) { appendLog(line); send("creator:drive-log", line); } },
  });
  return drive;
}

function createWindow() {
  if (win && !win.isDestroyed()) { win.show(); win.focus(); return win; }
  const page = join(webUi(), "creator.html");
  win = new BrowserWindow({
    width: 980, height: 700, minWidth: 760, minHeight: 520,
    show: false, backgroundColor: "#ffffff", title: "Creator",
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

/** 18pt luban mark for the menu bar; macOS picks up tray@2x.png beside it. */
function trayImage() {
  const file = join(__dirname, "assets", "tray.png");
  return existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

function createTray() {
  // Icon plus a short status word: a text-only item reads as an empty menu-bar
  // slot, and the words alone never showed which app they belonged to.
  tray = new Tray(trayImage());
  if (process.platform === "darwin") tray.setTitle("Creator");
  else tray.setToolTip("Creator");
  tray.on("click", toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Creator", click: () => createWindow() },
    { label: "立即开始执行任务", click: () => { bot.ensureWorker(home); refreshTray(); } },
    { type: "separator" },
    { label: "打开任务数据目录", click: () => { void shell.openPath(dataDirectory); } },
    { label: "允许的工具（permissions.json）", click: () => { void openPolicyFile(); } },
    { type: "separator" },
    { label: "退出 Creator（任务继续按时执行）", click: () => { quitting = true; app.quit(); } },
  ]));
  refreshTray();
}

function refreshTray() {
  if (!tray || tray.isDestroyed()) return;
  const status = bot.workerStatus(home);
  const label = status.running ? (status.task ? "Creator · 忙" : "Creator · 待命") : "Creator · 未启动";
  if (process.platform === "darwin") tray.setTitle(label.replace("Creator · ", ""));
  tray.setToolTip(`Creator — ${label}`);
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

ipcMain.handle("creator:settings", () => settings);

ipcMain.handle("creator:drive", () => {
  const bridge = ensureDrive();
  return { ...bridge.snapshot(), settings, log: logPath() };
});

ipcMain.handle("creator:drive-start", (_event, input) => {
  const bridge = ensureDrive();
  const workspace = String(input?.workspace || "").trim() || home;
  if (input?.computer === true && settings.computer !== true) {
    settings = { ...settings, computer: true };
    saveSettings();
  }
  bridge.start(workspace, { computer: settings.computer === true, allow: settings.allowed, model: input?.model, home });
  return bridge.snapshot();
});

ipcMain.handle("creator:drive-stop", () => ensureDrive().stop());

ipcMain.handle("creator:drive-say", (_event, text) => {
  const bridge = ensureDrive();
  const sent = bridge.say(text);
  return { sent, snapshot: bridge.snapshot() };
});

ipcMain.handle("creator:drive-approve", (_event, id, allow) => ensureDrive().approve(id, allow));

ipcMain.handle("creator:computer", (_event, on) => {
  settings = { ...settings, computer: on === true };
  saveSettings();
  // Switching off closes the session: an open control process must never keep
  // driving the desktop after the human turned the switch back.
  if (!settings.computer) ensureDrive().stop();
  return settings;
});

/** 忘掉已记住的授权: the next session asks again for every tool. */
ipcMain.handle("creator:forget", () => {
  settings = { ...settings, allowed: [] };
  saveSettings();
  // An open session already holds this list, so restart it to make the reset real.
  ensureDrive().stop();
  return settings;
});

ipcMain.handle("creator:memory", () => bot.memoryList(home));
ipcMain.handle("creator:memory-clear", (_event, workspace) => bot.clearMemory(home, workspace));

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
ipcMain.handle("creator:runs", (_event, id, limit) => bot.taskRuns(home, id, Number(limit) > 0 ? Number(limit) : 30));
ipcMain.handle("creator:startWorker", () => {
  const result = bot.ensureWorker(home);
  refreshTray();
  return { ...result, snapshot: snapshot() };
});
ipcMain.handle("creator:pickWorkspace", async () => {
  const picked = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "选择 Creator 的工作区" });
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
    loadSettings();
    ensureDrive();
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
          // Geometry beside the text: layout regressions are invisible in a sentence.
          const rects = await window.webContents.executeJavaScript(`(() => {
            const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
            const main = document.querySelector(".main");
            return {
              viewport: { w: innerWidth, h: innerHeight },
              main: main ? { scrollH: main.scrollHeight, clientH: main.clientHeight } : null,
              side: box(".side"), pane: box(".pane"), hero: box(".hero h1"), segmented: box(".segmented"),
              quick: box(".quick"), composer: box(".composer"), meta: box(".composer-meta"),
              suggest: box(".suggest"), disclaimer: box(".disclaimer"),
              pills: [...document.querySelectorAll(".suggest button")].map(el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }),
              queue: box(".queue"), tasks: [...document.querySelectorAll(".task")].map(el => Math.round(el.getBoundingClientRect().height)),
            };
          })()`);
          require("node:fs").writeFileSync(smokePath.replace(/\.png$/u, ".rects.json"), JSON.stringify(rects, null, 2));
          // The 交互记录 drawer is the "did it get booked" surface; smoke it on request so
          // its schedule rows and run history are proven to render, not just to exist.
          if (process.env.CREATOR_SMOKE_PLANS === "1") {
            const plansPath = smokePath.replace(/\.png$/u, "-plans.png");
            await window.webContents.executeJavaScript(`(() => {
              const button = [...document.querySelectorAll(".side-nav button")].find(node => node.textContent.includes("交互记录"));
              if (button) button.click();
            })()`);
            await new Promise(resolve => setTimeout(resolve, 400));
            // Expand the finished job: that is the one with run history to show.
            await window.webContents.executeJavaScript(`(() => {
              const head = document.querySelector(".plan.completed .plan-head") || document.querySelector(".plan-head");
              if (head) head.click();
            })()`);
            await new Promise(resolve => setTimeout(resolve, 700));
            require("node:fs").writeFileSync(plansPath, (await window.webContents.capturePage()).toPNG());
            const plans = await window.webContents.executeJavaScript(`(() => {
              const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
              return {
                title: document.querySelector(".drawer h2")?.textContent ?? "",
                drawer: box(".drawer"),
                sections: [...document.querySelectorAll(".drawer-section")].map(el => el.textContent),
                plans: [...document.querySelectorAll(".plan")].map(el => Math.round(el.getBoundingClientRect().height)),
                rows: [...document.querySelectorAll(".plan-prompt")].map(el => el.textContent),
                metas: [...document.querySelectorAll(".plan-meta")].map(el => el.textContent),
                runs: [...document.querySelectorAll(".runs li")].map(el => el.textContent.slice(0, 120)),
                scrollH: document.querySelector(".drawer-body")?.scrollHeight,
              };
            })()`);
            require("node:fs").writeFileSync(plansPath.replace(/\.png$/u, ".rects.json"), JSON.stringify(plans, null, 2));
          }
          // 记忆 is where a project's cross-run memory becomes visible: facts the
          // model kept plus the journal of finished runs, with one click to clear.
          if (process.env.CREATOR_SMOKE_MEMORY === "1") {
            const memoryPath = smokePath.replace(/\.png$/u, "-memory.png");
            await window.webContents.executeJavaScript(`(() => {
              const button = [...document.querySelectorAll(".side-nav button")].find(node => node.textContent.includes("记忆"));
              if (button) button.click();
            })()`);
            await new Promise(resolve => setTimeout(resolve, 700));
            const memory = await window.webContents.executeJavaScript(`(() => {
              const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
              return {
                title: document.querySelector(".drawer h2")?.textContent ?? "",
                drawer: box(".drawer"),
                projects: [...document.querySelectorAll(".memory-project")].map(el => el.innerText.slice(0, 240)),
                rows: [...document.querySelectorAll(".memory-list li")].map(el => el.innerText.slice(0, 120)),
                clear: [...document.querySelectorAll(".memory-project .wide")].map(el => el.textContent),
                scrollH: document.querySelector(".drawer-body")?.scrollHeight,
              };
            })()`);
            require("node:fs").writeFileSync(memoryPath, (await window.webContents.capturePage()).toPNG());
            require("node:fs").writeFileSync(memoryPath.replace(/\.png$/u, ".json"), JSON.stringify(memory, null, 2));
            process.stdout.write(`memory ${JSON.stringify(memory)}\n`);
          }
          // 授权 is where a standing 允许 becomes visible and revocable. Prove the
          // page lists what creator.json remembered, or it is memory nobody sees.
          if (process.env.CREATOR_SMOKE_APPROVALS === "1") {
            const approvalsPath = smokePath.replace(/\.png$/u, "-approvals.png");
            await window.webContents.executeJavaScript(`(() => {
              // Selected by data-view: the visible label may be reworded, the hook may not break.
              document.querySelector('[data-view="queue"]')?.click();
            })()`);
            await new Promise(resolve => setTimeout(resolve, 300));
            await window.webContents.executeJavaScript(`(() => {
              const tab = [...document.querySelectorAll("button")].find(node => node.textContent.trim() === "授权");
              if (tab) tab.click();
            })()`);
            await new Promise(resolve => setTimeout(resolve, 400));
            const approvals = await window.webContents.executeJavaScript(`(() => ({
              remembered: document.querySelector('[aria-label="已记住的授权"]')?.innerText ?? "",
              forget: !!document.querySelector('[aria-label="已记住的授权"] button'),
              requests: [...document.querySelectorAll(".request")].map(el => el.innerText.slice(0, 80)),
            }))()`);
            require("node:fs").writeFileSync(approvalsPath, (await window.webContents.capturePage()).toPNG());
            require("node:fs").writeFileSync(approvalsPath.replace(/\.png$/u, ".json"), JSON.stringify(approvals, null, 2));
            process.stdout.write(`approvals ${JSON.stringify(approvals)}\n`);
            // Forgetting has to be one click, not a trip to a JSON file: click it
            // and read both the page and creator.json back.
            if (process.env.CREATOR_SMOKE_FORGET === "1") {
              await window.webContents.executeJavaScript(`(() => {
                const button = document.querySelector('[aria-label="已记住的授权"] button');
                if (button) button.click();
              })()`);
              await new Promise(resolve => setTimeout(resolve, 800));
              const left = await window.webContents.executeJavaScript("!!document.querySelector('[aria-label=\"已记住的授权\"]')");
              const stored = JSON.parse(require("node:fs").readFileSync(settingsPath(), "utf8"));
              require("node:fs").writeFileSync(approvalsPath.replace(/\.png$/u, "-forgot.json"), JSON.stringify({ page: left, stored }, null, 2));
              process.stdout.write(`forgot ${JSON.stringify({ page: left, stored })}\n`);
            }
          }
          // The 任务记录 tab is the queue's face: its composer is one sentence box.
          // It used to carry 现在/定时/每隔 controls, so a smoke proves the form is
          // gone and what is left is the textarea plus send.
          if (process.env.CREATOR_SMOKE_QUEUE === "1") {
            const queuePath = smokePath.replace(/\.png$/u, "-queue.png");
            await window.webContents.executeJavaScript(`(() => {
              document.querySelector('[data-view="queue"]')?.click();
            })()`);
            await new Promise(resolve => setTimeout(resolve, 400));
            const composer = await window.webContents.executeJavaScript(`(() => {
              const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
              return {
                composer: box(".composer"),
                placeholder: document.querySelector(".composer textarea")?.placeholder ?? "",
                controls: [...document.querySelectorAll(".composer select, .composer input")].map(el => el.tagName + "." + el.className),
                parsed: document.querySelector(".composer-meta .parsed")?.textContent ?? "",
                send: box(".composer .send"),
              };
            })()`);
            require("node:fs").writeFileSync(queuePath, (await window.webContents.capturePage()).toPNG());
            require("node:fs").writeFileSync(queuePath.replace(/\.png$/u, ".json"), JSON.stringify(composer, null, 2));
            process.stdout.write(`queue composer ${JSON.stringify(composer)}\n`);
          }
          // The control panel is the point of this window, and a panel that only
          // renders is not the same as one that drives the machine: run a real
          // turn through the same bridge the 输入框 uses, then capture it.
          // Types into the real composer like a person would: "does the window
          // answer me" is a question about the renderer, not about the bridge.
          if (process.env.CREATOR_SMOKE_UI) {
            const typed = String(process.env.CREATOR_SMOKE_UI);
            const uiShot = smokePath.replace(/\.png$/u, "-ui.png");
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const step = await window.webContents.executeJavaScript(`(async () => {
              const box = document.querySelector(".drive-composer textarea");
              if (!box) return { error: "窗口里没有输入框" };
              box.focus();
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
              setter.call(box, ${JSON.stringify(typed)});
              box.dispatchEvent(new Event("input", { bubbles: true }));
              await new Promise(resolve => setTimeout(resolve, 250));
              const button = [...document.querySelectorAll(".drive-composer button")].find(node => String(node.className).includes("send"));
              if (!button) return { error: "没有发送按钮", typed: box.value };
              button.click();
              return { typed: box.value, disabled: button.disabled === true };
            })()`);
            const readLog = () => window.webContents.executeJavaScript("document.querySelector('.drive-log') ? document.querySelector('.drive-log').innerText : ''");
            let logText = "";
            for (let i = 0; i < 90; i++) {
              await sleep(1000);
              logText = await readLog();
              if (/结束|没有正常结束/.test(logText)) break;
            }
            require("node:fs").writeFileSync(uiShot, (await window.webContents.capturePage()).toPNG());
            require("node:fs").writeFileSync(uiShot.replace(/\.png$/u, ".txt"), String(logText));
            require("node:fs").writeFileSync(uiShot.replace(/\.png$/u, ".json"), JSON.stringify({ step, logText }, null, 2));
          }
          if (process.env.CREATOR_SMOKE_DRIVE) {
            const prompt = process.env.CREATOR_SMOKE_DRIVE === "1"
              ? "在计算器里算 6*7，把屏幕上的结果显示给我"
              : String(process.env.CREATOR_SMOKE_DRIVE);
            const driveShot = smokePath.replace(/\.png$/u, "-drive.png");
            const bridge = ensureDrive();
            const approved = new Set();
            bridge.start(process.env.CREATOR_SMOKE_WORKSPACE || join(home, "workspace"), { computer: true });
            for (let i = 0; i < 40 && !bridge.snapshot().ready; i++) await new Promise(r => setTimeout(r, 300));
            bridge.say(prompt);
            const done = () => bridge.snapshot().events.some(event => event.type === "turn-end");
            for (let i = 0; i < 500 && !done(); i++) {
              for (const event of bridge.snapshot().events) {
                if (event.type !== "approval" || approved.has(event.id)) continue;
                approved.add(event.id);
                bridge.approve(event.id, true);
              }
              await new Promise(r => setTimeout(r, 400));
            }
            await new Promise(r => setTimeout(r, 500));
            require("node:fs").writeFileSync(driveShot, (await window.webContents.capturePage()).toPNG());
            const driveText = await window.webContents.executeJavaScript("document.body.innerText");
            require("node:fs").writeFileSync(driveShot.replace(/\.png$/u, ".txt"), String(driveText));
            const driveRects = await window.webContents.executeJavaScript(`(() => {
              const box = (selector) => { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
              return {
                viewport: { w: innerWidth, h: innerHeight },
                log: box(".drive-log"),
                acts: [...document.querySelectorAll(".act")].map(el => ({ text: el.textContent.slice(0, 90), cls: el.className })),
                shots: [...document.querySelectorAll(".act-shot")].map(el => ({ w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), src: String(el.getAttribute("src") || "").slice(0, 30) })),
                asks: [...document.querySelectorAll(".ask")].map(el => el.textContent.slice(0, 120)),
                scrollH: document.querySelector(".drive-log")?.scrollHeight,
              };
            })()`);
            const driveSnapshot = bridge.snapshot();
            require("node:fs").writeFileSync(driveShot.replace(/\.png$/u, ".rects.json"), JSON.stringify({
              ...driveRects,
              session: { running: driveSnapshot.running, ready: driveSnapshot.ready, error: driveSnapshot.error, events: driveSnapshot.events.length, types: driveSnapshot.events.slice(0, 12).map(event => event.type) },
            }, null, 2));
            bridge.stop();
          }
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
  app.on("before-quit", () => { quitting = true; ensureDrive().stop(); });
}
