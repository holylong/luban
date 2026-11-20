#!/usr/bin/env node
// Measure how often the device page's workspace rows vanish while polling.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require("electron"), [__filename], { env, stdio: "inherit" });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow } = require("electron");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "luban-flicker-probe-"));
  app.setPath("userData", path.join(home, "profile"));
  // Fixture paths only: derive them from the repo instead of hard-coding a
  // developer's home. Both directories must exist and must not look like a
  // scratch probe, or the device page hides their rows and the probe measures
  // nothing.
  const repoRoot = path.resolve(__dirname, "..");
  const projects = {
    luban: process.env.LUBAN_PROBE_PROJECT || repoRoot,
    cooler: process.env.LUBAN_PROBE_COOLER || path.join(repoRoot, "apps", "creator"),
  };
  const session = (id, project, title) => ({ id, project, title, workspace: projects[project], model: "test", mode: "agent",
    messages: 2, edits: 0, createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T11:00:00Z" });
  const sessions = {
    luban: [session("a1", "luban", "整理右键菜单")],
    cooler: [session("b1", "cooler", "cooler 会话一"), session("b2", "cooler", "cooler 会话二")],
  };
  let beat = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    const node = url.searchParams.get("node") || "n-one";
    const json = body => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/auth/me") return json({ account: { id: "fixture", email: "fixture@example.test" } });
    if (url.pathname === "/relay/nodes") {
      beat++;
      return json({ ok: true, nodes: [
        { id: "n-one", device_id: "dev-0123456789abcdef-1111111111111111", name: "work-mac · luban", workspace: projects.luban, projects: { luban: projects.luban, cooler: projects.cooler }, online: true, last_seen: beat },
        { id: "n-two", device_id: "dev-0123456789abcdef-2222222222222222", name: "work-mac · cooler", workspace: projects.cooler, projects: {}, online: true, last_seen: beat + (beat % 2) },
      ] });
    }
    if (url.pathname === "/api/node") return json({ name: "work-mac", project: "luban", workspace: projects.luban, projects });
    if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": ready\n\n"); return; }
    if (url.pathname === "/api/sessions") return json(sessions[url.searchParams.get("project")] || []);
    if (url.pathname.startsWith("/api/")) return json([]);
    const relative = url.pathname === "/m/" ? "mobile.html" : url.pathname.replace(/^\/m\//, "");
    const root = path.resolve(__dirname, "../dist/web-ui");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(file));
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  (async () => {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const win = new BrowserWindow({ width: 390, height: 844, show: false, useContentSize: true, webPreferences: { contextIsolation: true } });
    const js = expression => win.webContents.executeJavaScript(expression);
    const until = async expression => {
      for (let i = 0; i < 100; i++) { if (await js(expression)) return; await wait(100); }
      throw new Error("Timed out: " + expression);
    };
    await win.loadURL(`http://127.0.0.1:${server.address().port}/m/`);
    await until('document.body.innerText.includes("work-mac")');
    await js('[...document.querySelectorAll(".m-tabs button")].find(e=>e.textContent.includes("设备")).click()');
    await until('document.querySelectorAll(".m-workspace").length === 2');
    await js('[...document.querySelectorAll(".m-workspace")].find(e=>e.textContent.includes("cooler")).querySelector(".m-collapse").click()');
    await until('document.querySelectorAll(".m-workspace .m-pick").length === 2');
    // Sampling every 120ms can miss a single blank paint; watch the DOM so a
    // row that is torn out and rebuilt is counted even if it comes back at once.
    await js(`(() => {
      window.__probe = { pickRemovals: 0, loadingMutations: 0, reopens: 0 };
      const pickCount = node => node.nodeType === 1
        ? (node.matches(".m-pick") ? 1 : 0) + node.querySelectorAll(".m-pick").length : 0;
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.removedNodes) window.__probe.pickRemovals += pickCount(node);
          for (const node of record.addedNodes) if (pickCount(node)) window.__probe.reopens++;
        }
        if (document.querySelector(".m-workspaces [role=status]")) window.__probe.loadingMutations++;
      }).observe(document.body, { subtree: true, childList: true });
      return true;
    })()`);
    await js('document.querySelector(".m-main").scrollTop = 150');
    const geometry = () => js(`JSON.stringify({ scroll: document.querySelector('.m-main').scrollTop,
      rows: [...document.querySelectorAll('.m-workspace')].map(e => [e.querySelector('strong').textContent, e.getBoundingClientRect().top]) })`);
    const initialGeometry = await geometry();
    let geometryChanges = 0;
    const samples = [];
    const start = Date.now();
    while (Date.now() - start < 12000) {
      samples.push(await js(`(() => ({
        at: Math.round(performance.now()),
        cards: document.querySelectorAll(".m-workspace").length,
        rows: document.querySelectorAll(".m-workspace .m-pick").length,
        loading: document.body.innerText.includes("正在读取工作区和会话"),
        notes: [...document.querySelectorAll(".m-workspace .m-note")].map(e => e.textContent.slice(0, 16)).join("|"),
        collapses: [...document.querySelectorAll(".m-workspace .m-collapse")].map(e => e.textContent.replace(/\s+/g, " ").slice(0, 24) + "@" + e.getAttribute("aria-expanded")).join(" ; "),
      }))()`));
      if (await geometry() !== initialGeometry) geometryChanges++;
      await wait(120);
    }
    const emptyCards = samples.filter(s => s.cards === 0).length;
    const lostRows = samples.filter(s => s.cards > 0 && s.rows === 0).length;
    const loading = samples.filter(s => s.loading).length;
    const transitions = samples.reduce((count, sample, index) => index && sample.cards !== samples[index - 1].cards ? count + 1 : count, 0);
    const mutations = await js("window.__probe");
    console.log(JSON.stringify({ samples: samples.length, emptyCards, lostRows, loading, transitions, geometryChanges, relayPolls: beat, initialGeometry, ...mutations }, null, 2));
    if (emptyCards || lostRows || loading || transitions || geometryChanges || mutations.pickRemovals || mutations.loadingMutations || beat < 2)
      throw new Error("Polling changed expanded inventory DOM or scroll geometry");
    for (const sample of samples.filter((_, index) => index % 6 === 0).slice(0, 18)) console.log(JSON.stringify(sample));
    win.destroy(); server.closeAllConnections(); server.close(); app.quit();
  })().catch(error => { console.error(error); server.closeAllConnections(); server.close(); app.exit(1); });
}
