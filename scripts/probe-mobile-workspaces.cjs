#!/usr/bin/env node
// Real Chromium rendering of the shipped /m/ bundle, with deterministic relay
// fixtures. No model calls or external account/device mutations.
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "luban-mobile-probe-"));
  app.setPath("userData", path.join(home, "profile"));
  const requests = [];
  const projects = { a: { original: "/work/original" }, b: { original: "/work/b-original", newlyCreated: "/work/newly-created" } };
  const session = (id, project, title) => ({ id, project, title, workspace: "/work/" + project, model: "test", mode: "agent", messages: 2, edits: 0,
    createdAt: "2026-11-14T10:00:00Z", updatedAt: "2026-11-14T11:00:00Z" });
  // A CLI start writes a system-prompt-only record, so every workspace on disk
  // carries drafts like this one; the phone list must not show them.
  const sessions = { original: [session("old", "original", "旧会话"), { ...session("draft", "original", ""), messages: 0 }], newlyCreated: [session("first", "newlyCreated", "新工作区的第一个会话"), session("second", "newlyCreated", "第二个会话" + "长标题".repeat(25))] };
  const info = node => ({ name: node === "b" ? "第二台电脑" : "第一台电脑", project: "original", workspace: projects[node].original,
    projects: projects[node], models: [], model: "test", capabilities: [], version: "test", web: {} });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://local");
    const node = url.searchParams.get("node") || "a";
    requests.push({ path: url.pathname, node, project: url.searchParams.get("project"), method: req.method });
    const json = body => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
    if (url.pathname === "/api/auth/me") return json({ account: { id: "fixture", email: "fixture@example.test" } });
    if (url.pathname === "/relay/nodes") return json({ ok: true, nodes: ["a", "b"].map(id => ({ id, name: info(id).name, workspace: info(id).workspace, projects: projects[id], online: true })) });
    if (url.pathname === "/api/node") return json(info(node));
    if (url.pathname === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": ready\n\n"); return; }
    if (url.pathname === "/api/projects") {
      projects[node].phoneCreated = "/work/phone-created";
      return json({ ok: true, project: "phoneCreated", workspace: projects[node].phoneCreated, created: true });
    }
    if (url.pathname === "/api/sessions") return json(sessions[url.searchParams.get("project")] || []);
    if (url.pathname.endsWith("/delete")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-2));
      const project = url.searchParams.get("project");
      sessions[project] = (sessions[project] || []).filter(item => item.id !== id);
      return json({ ok: true });
    }
    if (url.pathname.startsWith("/api/sessions/")) {
      const item = Object.values(sessions).flat().find(item => item.id === url.pathname.split("/").pop());
      return json({ ...item, messages: [{ role: "user", content: "这是第二台电脑新工作区的独立历史" }, { role: "assistant", content: "确实打开了第二个会话" }] });
    }
    if (url.pathname.startsWith("/api/")) return json([]);
    const relative = url.pathname === "/m/" ? "mobile.html" : url.pathname.replace(/^\/m\//, "");
    const root = path.resolve(__dirname, "../dist/web-ui");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader("content-type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(file));
  });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const assert = (value, message) => { if (!value) throw new Error(message); };
  (async () => {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const win = new BrowserWindow({ width: 390, height: 844, show: false, useContentSize: true, webPreferences: { contextIsolation: true } });
    const js = expression => win.webContents.executeJavaScript(expression);
    const until = async expression => {
      for (let i = 0; i < 60; i++) { if (await js(expression)) return; await wait(100); }
      throw new Error("Timed out: " + expression);
    };
    await win.loadURL(`http://127.0.0.1:${server.address().port}/m/`);
    await until('document.body.innerText.includes("第一台电脑")');
    await js('[...document.querySelectorAll(".m-tabs button")].find(e=>e.textContent.includes("设备")).click()');
    await until('document.querySelectorAll(".m-workspace").length === 3');
    for (const width of [320, 390, 430]) {
      win.setContentSize(width, 844);
      await until(`innerWidth === ${width}`);
      const geometry = await js(`(() => {
        const viewport = innerWidth;
        const overflow = [...document.querySelectorAll('.m-workspace,.m-workspace .m-pick,.m-workspaces-heading')].filter(e=>e.getBoundingClientRect().right>viewport || e.scrollWidth>e.clientWidth+1);
        return { viewport, page: document.documentElement.scrollWidth, overflow: overflow.length };
      })()`);
      assert(geometry.page === width && !geometry.overflow, "layout overflow: " + JSON.stringify(geometry));
      console.log("layout", JSON.stringify(geometry));
    }
    win.setContentSize(390, 844);
    fs.writeFileSync(path.join(home, "devices.png"), (await win.webContents.capturePage()).toPNG());
    assert(await js('document.querySelectorAll(".m-workspace .m-pick").length === 0'), "sessions must start collapsed");
    const draftLeak = await js(`(() => { const card = [...document.querySelectorAll(".m-workspace")].find(e => e.textContent.includes("original"));
      return { text: card.innerText, rows: card.querySelectorAll(".m-session-row").length, drafts: document.body.innerText.includes("未命名会话") }; })()`);
    assert(!draftLeak.drafts && draftLeak.text.includes("1 个"), "a draft session leaked into the phone list: " + JSON.stringify(draftLeak));
    console.log("draft filter", JSON.stringify(draftLeak));
    await js('[...document.querySelectorAll(".m-workspace")].find(e=>e.textContent.includes("newlyCreated")).querySelector(".m-collapse").click()');
    await until('document.querySelectorAll(".m-workspace .m-pick").length === 2');
    await js('[...document.querySelectorAll(".m-workspace .m-pick")].find(e=>e.textContent.includes("第二个会话")).click()');
    await until('document.body.innerText.includes("确实打开了第二个会话")');
    assert(requests.some(req => req.path === "/api/sessions/second" && req.node === "b" && req.project === "newlyCreated"), "wrong session route");
    assert(await js('document.querySelector(".m-head-bar").textContent.includes("newlyCreated")'), "missing workspace orientation");
    await js('document.querySelector(".m-head-bar").click()');
    await until('document.querySelectorAll(".m-workspace").length === 3');
    await js('[...document.querySelectorAll(".m-workspace")].find(e=>e.textContent.includes("newlyCreated")).querySelector(".m-btn").click()');
    await wait(1300);
    assert(await js('!document.querySelector(".m-session-bar") && !document.body.innerText.includes("确实打开了第二个会话")'), "new session reused old history");
    await js('document.querySelector(".m-head-bar").click()');
    await until('document.querySelectorAll(".m-workspaces").length === 2');
    await js('window.prompt = () => "phoneCreated"; document.querySelectorAll(".m-workspaces")[1].querySelector("button").click()');
    await until('document.querySelector(".m-head-bar").textContent.includes("phoneCreated")');
    await js('document.querySelector(".m-head-bar").click()');
    await until('document.body.innerText.includes("/work/phone-created")');
    assert(requests.some(req=>req.path === "/api/projects" && req.node === "b"), "created workspace on wrong device");
    // Deleting a session is confirmed, scoped to this device and project, and row-counted.
    await js('[...document.querySelectorAll(".m-workspace")].find(e=>e.textContent.includes("newlyCreated")).querySelector(".m-collapse").click()');
    await until('document.querySelectorAll(".m-workspace .m-pick").length === 2');
    win.setContentSize(320, 844);
    await until('innerWidth === 320');
    const expanded = await js(`(() => ({ page: document.documentElement.scrollWidth,
      wide: [...document.querySelectorAll('.m-session-row,.m-session-row .m-btn,.m-workspace .m-pick')].filter(e => e.getBoundingClientRect().right > innerWidth + 0.5 || e.scrollWidth > e.clientWidth + 1).length }))()`);
    assert(expanded.page === 320 && !expanded.wide, "expanded rows overflow at 320px: " + JSON.stringify(expanded));
    win.setContentSize(390, 844);
    await until('innerWidth === 390');
    await js(`window.confirm = message => { window.__confirmed = message; return true; };
      [...document.querySelectorAll('.m-workspace button[aria-label]')]
        .find(element => element.getAttribute('aria-label').includes('第一个会话')).click()`);
    await until('document.querySelectorAll(".m-workspace .m-pick").length === 1');
    assert(requests.some(req => req.path === "/api/sessions/first/delete" && req.node === "b" && req.project === "newlyCreated"), "delete hit the wrong session route");
    assert(await js('window.__confirmed.includes("无法恢复") && !document.querySelector(".m-workspace .m-pick").textContent.includes("第一个会话")'), "delete lacked confirmation or kept the row");
    console.log("PROBE OK: direct second-device/session opening, blank new session, newly created workspace visible on return; shots:", home);
    win.destroy();
    server.closeAllConnections(); server.close(); app.quit();
  })().catch(error => { console.error(error); server.closeAllConnections(); server.close(); app.exit(1); });
}
