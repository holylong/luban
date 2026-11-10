/**
 * Measure and screenshot the phone page at a real phone size.
 *
 * The transcript is the reason the page exists, so the probe reports how many
 * pixels each chrome band (header, composer, tab bar) takes away from it. It
 * runs the real backend so the page has real data instead of the anonymous
 * shell: `node scripts/mobile-layout-probe.cjs` after `npm run build`.
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { spawn } = require("node:child_process");

const WIDTH = Number(process.env.LUBAN_PROBE_WIDTH || 390);
const HEIGHT = Number(process.env.LUBAN_PROBE_HEIGHT || 844);
const TAB = process.env.LUBAN_PROBE_TAB || "live";
const TOKEN = "probe-token";

app.disableHardwareAcceleration();

function startBackend(workspace) {
  const child = spawn(process.execPath, [join(__dirname, "..", "dist", "cli.js"), "web", workspace,
    "--host", "127.0.0.1", "--port", "0", "--no-mesh"], {
    env: { ...process.env, LUBAN_WEB_TOKEN: TOKEN, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`backend timeout: ${output.slice(-300)}`)), 20000);
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const match = /^luban web (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(output);
      if (match) { clearTimeout(timer); resolve({ child, url: match[1] }); }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
  });
}

app.whenReady().then(async () => {
  const { child, url } = await startBackend(join(__dirname, ".."));
  const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false, webPreferences: { offscreen: true } });
  await win.loadURL(`${url}m/?token=${TOKEN}`);
  await new Promise(resolve => setTimeout(resolve, 2500));
  if (process.env.LUBAN_PROBE_SESSION) {
    // Pick a saved session the way a person would: 设置 → 派活 → 会话.
    await win.webContents.executeJavaScript(`(() => {
      const tab = [...document.querySelectorAll(".m-tab")].find(node => node.textContent.trim().endsWith("设置"));
      tab?.click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 600));
    await win.webContents.executeJavaScript(`(() => {
      const collapse = document.querySelector('.m-collapse[aria-label="继续会话"]');
      if (!collapse) return "no-session-collapse";
      collapse.click();
      return "opened";
    })()`);
    await new Promise(resolve => setTimeout(resolve, 400));
    await win.webContents.executeJavaScript(`(() => {
      const pick = [...document.querySelectorAll(".m-pick")].find(item => item.classList.contains("active") === false && !item.textContent.includes("新会话"));
      if (!pick) return "no-saved-session";
      pick.click();
      return pick.textContent;
    })()`).then(picked => console.log("session:", picked));
    await new Promise(resolve => setTimeout(resolve, 1200));
    await win.webContents.executeJavaScript(`(() => {
      const tab = [...document.querySelectorAll(".m-tab")].find(node => node.textContent.trim().endsWith("状态"));
      tab?.click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  if (TAB !== "live") {
    await win.webContents.executeJavaScript(`(() => {
      const tab = [...document.querySelectorAll(".m-tab")].find(node => node.textContent.trim().endsWith("${TAB}"));
      tab?.click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 800));
  }
  // The settings lists fold: both long lists are closed until asked for.
  const folding = await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll(".m-tab")].find(node => node.textContent.trim().endsWith("设置"));
    tab?.click();
    return null;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 800));
  await win.webContents.executeJavaScript(`(() => {
    const heads = [...document.querySelectorAll(".m-collapse")].map(node => ({
      label: node.querySelector(".m-collapse-label")?.textContent ?? "",
      summary: node.querySelector(".m-collapse-summary")?.textContent ?? "",
      expanded: node.getAttribute("aria-expanded"),
    }));
    console.log("FOLD", JSON.stringify(heads), "models", document.querySelectorAll(".m-model").length, "picks", document.querySelectorAll(".m-pick").length);
    return heads;
  })()`).then(heads => console.log("折叠面板:", JSON.stringify(heads)));
  await win.webContents.executeJavaScript(`(() => {
    const heads = [...document.querySelectorAll(".m-collapse")];
    heads.forEach(node => node.click());
    return null;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 600));
  await win.webContents.executeJavaScript(`(() => ({
    models: document.querySelectorAll(".m-model").length,
    picks: document.querySelectorAll(".m-pick").length,
    expanded: [...document.querySelectorAll(".m-collapse")].map(node => node.getAttribute("aria-expanded")),
  }))()`).then(open => console.log("展开后:", JSON.stringify(open)));
  if (TAB !== "settings") await win.webContents.executeJavaScript(`(() => {
    const tab = [...document.querySelectorAll(".m-tab")].find(node => node.textContent.trim().endsWith("${TAB}"));
    tab?.click();
  })()`);

  const metrics = await win.webContents.executeJavaScript(`(() => {
    const box = selector => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { height: Math.round(r.height), top: Math.round(r.top) };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      header: box(".m-head"),
      main: box(".m-main"),
      transcriptShare: (() => {
        const main = document.querySelector(".m-main");
        return main ? Math.round(main.getBoundingClientRect().height / innerHeight * 100) + "%" : null;
      })(),
      compose: box(".m-compose"),
      tabs: box(".m-tabs"),
      turns: document.querySelectorAll(".m-turn, .m-tool").length,
    };
  })()`);
  console.log(JSON.stringify(metrics, null, 1));
  const image = await win.webContents.capturePage();
  const target = process.env.LUBAN_PROBE_SHOT || join(__dirname, "..", ".luban", `mobile-${TAB}.png`);
  writeFileSync(target, image.toPNG());
  console.log("shot:", target);
  child.kill("SIGTERM");
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
