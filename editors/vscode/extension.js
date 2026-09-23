// Minimal VS Code bridge to `luban acp` over newline-delimited JSON-RPC.
// Install: npm link -g luban (or have `luban` on PATH), then copy or
// symlink editors/vscode into ~/.vscode/extensions/luban-0.8.0.
const { spawn } = require("node:child_process");
const vscode = require("vscode");

let child = null;
let sessionId = null;
let nextId = 1;
const pending = new Map();
let buffer = "";
let output = null;

function send(message) {
  if (!child) throw new Error("luban backend is not running");
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params, timeoutMs = 120_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    try {
      send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    }
  });
}

function ensureBackend(workspace) {
  if (child) return;
  output = output || vscode.window.createOutputChannel("luban");
  child = spawn("luban", ["acp", workspace], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(line);
      newline = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk) => output.append(chunk.toString()));
  child.on("error", (error) => {
    vscode.window.showErrorMessage(`luban backend failed to start: ${error.message}`);
    child = null;
  });
  child.on("close", (code) => {
    for (const entry of pending.values()) entry.reject(new Error(`backend exited with ${code}`));
    pending.clear();
    child = null;
    sessionId = null;
  });
}

function onMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message || "backend error"));
    else entry.resolve(message.result);
    return;
  }
  if (message.method === "session/update") {
    const chunk = message.params?.update?.content?.text;
    if (typeof chunk === "string" && output) output.append(chunk);
  }
}

async function ensureSession() {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) throw new Error("open a folder first");
  ensureBackend(workspace);
  await request("initialize", {});
  if (!sessionId) {
    const created = await request("session/new", { cwd: workspace });
    sessionId = created.sessionId;
  }
  return workspace;
}

async function runPrompt(text) {
  await ensureSession();
  if (output) output.show(true);
  const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 600_000);
  if (output) output.appendLine(`\n[luban stop: ${result.stopReason}]`);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("luban.ask", async () => {
      const text = await vscode.window.showInputBox({ prompt: "Ask luban (runs in the open folder)" });
      if (!text) return;
      try {
        await runPrompt(text);
      } catch (error) {
        vscode.window.showErrorMessage(`luban: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("luban.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showInformationMessage("luban: nothing selected");
        return;
      }
      const file = editor.document.fileName;
      try {
        await runPrompt(`File: ${file}\n\nSelected code:\n\`\`\`\n${selection}\n\`\`\`\n\nExplain or act on the selection above.`);
      } catch (error) {
        vscode.window.showErrorMessage(`luban: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("luban.sendFile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("luban: no open file");
        return;
      }
      try {
        await runPrompt(`Review @${vscode.workspace.asRelativePath(editor.document.uri)} and report issues.`);
      } catch (error) {
        vscode.window.showErrorMessage(`luban: ${error.message}`);
      }
    }),
    vscode.commands.registerCommand("luban.cancel", async () => {
      if (!child || !sessionId) {
        vscode.window.showInformationMessage("luban: nothing running");
        return;
      }
      try {
        await request("session/cancel", { sessionId });
      } catch (error) {
        vscode.window.showErrorMessage(`luban: ${error.message}`);
      }
    }),
  );
}

function deactivate() {
  try {
    child?.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  child = null;
}

module.exports = { activate, deactivate };
