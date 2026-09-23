import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTools } from "./tools.js";
import type { LubanConfig } from "./types.js";

async function setup() {
  const workspace = await mkdtemp(join(tmpdir(), "luban-tools-"));
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "a.ts"), "export const answer = 41;\n");
  const model = { id: "test/model", provider: "test", model: "model", name: "model", baseUrl: "", apiKey: "" };
  const config: LubanConfig = {
    home: workspace, workspace, project: "test", model, models: [model], maxTokens: 1000,
    temperature: 0, timeoutMs: 1000, maxSteps: 10, backendUrl: "", permissionMode: "allow",
  };
  return { workspace, tools: createTools(config), signal: new AbortController().signal };
}

describe("workspace tools", () => {
  it("reads, searches, edits and runs commands", async () => {
    const { workspace, tools, signal } = await setup();
    expect(await tools.get("read_file")!.execute({ path: "src/a.ts" }, signal)).toContain("answer = 41");
    expect(await tools.get("grep_files")!.execute({ pattern: "answer" }, signal)).toContain("src/a.ts:1");
    await tools.get("edit_file")!.execute({ path: "src/a.ts", old_text: "41", new_text: "42" }, signal);
    expect(await readFile(join(workspace, "src", "a.ts"), "utf8")).toContain("42");
    expect(await tools.get("bash")!.execute({ command: "printf node-ok" }, signal)).toBe("node-ok");
  });

  it("rejects paths outside the workspace", async () => {
    const { tools, signal } = await setup();
    await expect(tools.get("read_file")!.execute({ path: "../secret" }, signal)).rejects.toThrow("escapes workspace");
  });

  // Non-zero exits are reported as data rather than failing the tool. The
  // previous contract rejected them, which turned ordinary exploration
  // (`grep` with no match, `git diff --quiet`, `test -f`, `command -v`) into
  // "TOOL ERROR" and hid the difference between "returned 1" and "could not
  // run". The model still sees the code and the output, so nothing is lost.
  it("reports a non-zero exit as data while keeping the output", async () => {
    const { tools, signal } = await setup();
    const result = await tools.get("bash")!.execute({ command: "printf failed; exit 7" }, signal);
    expect(result).toContain("failed");
    expect(result).toContain("[exit code: 7]");
  });

  it("reports the exit code of a failing pipeline", async () => {
    const { tools, signal } = await setup();
    // pipefail is enabled, so the pipeline reports the failing left-hand side.
    expect(await tools.get("bash")!.execute({ command: "false | true" }, signal)).toContain("[exit code: 1]");
  });

  it.skipIf(process.platform === "win32")("uses bash semantics regardless of the user's login shell", async () => {
    const original = process.env.SHELL;
    const { tools, signal } = await setup();
    try {
      for (const shell of ["/bin/sh", "/nonexistent/fish"]) {
        process.env.SHELL = shell;
        await expect(tools.get("bash")!.execute({ command: '[[ -n "$BASH_VERSION" ]] && printf compatible' }, signal)).resolves.toBe("compatible");
        expect(await tools.get("bash")!.execute({ command: "false | true" }, signal)).toContain("[exit code: 1]");
      }
    } finally {
      if (original === undefined) delete process.env.SHELL;
      else process.env.SHELL = original;
    }
  });

  it("applies a checked unified diff and rejects escaping patch paths", async () => {
    const { workspace, tools, signal } = await setup();
    const patch = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-export const answer = 41;",
      "+export const answer = 42;",
      "",
    ].join("\n");
    await expect(tools.get("apply_patch")!.execute({ patch }, signal)).resolves.toContain("1 file");
    await expect(readFile(join(workspace, "src/a.ts"), "utf8")).resolves.toContain("42");
    await expect(tools.get("apply_patch")!.execute({ patch: "--- a/../bad\n+++ b/../bad\n@@ -0,0 +1 @@\n+x\n" }, signal))
      .rejects.toThrow("escapes workspace");
  });

  it("discovers and reads project skills", async () => {
    const { workspace, tools, signal } = await setup();
    await mkdir(join(workspace, ".luban", "skills", "review"), { recursive: true });
    await writeFile(join(workspace, ".luban", "skills", "review", "SKILL.md"), "# Review\nCheck the diff.\n");
    await expect(tools.get("list_skills")!.execute({}, signal)).resolves.toContain("review");
    await expect(tools.get("read_skill")!.execute({ name: "review" }, signal)).resolves.toContain("Check the diff");
  });

  it("accepts stdin on running background tasks", async () => {
    if (process.platform === "win32") return;
    const { tools, signal } = await setup();
    const started = await tools.get("bash")!.execute({ command: "cat", background: true }, signal);
    const id = started.split(" ")[2]!;
    await expect(tools.get("send_background_input")!.execute({ task_id: id, input: "hello-stdin" }, signal)).resolves.toContain("sent");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const status = JSON.parse(await tools.get("get_background_task")!.execute({ task_id: id }, signal));
    expect(status.output).toContain("hello-stdin");
    await expect(tools.get("stop_background_task")!.execute({ task_id: id }, signal)).resolves.toContain("stopping");
  });

  it("allocates a real PTY when requested", async () => {
    const { tools, signal } = await setup();
    const { ptyScriptBinary } = await import("./tools.js");
    if (process.platform === "win32" || !ptyScriptBinary()) return;
    await expect(tools.get("bash")!.execute({ command: "if [ -t 1 ]; then echo IS_TTY; else echo NO_TTY; fi", pty: true }, signal))
      .resolves.toContain("IS_TTY");
    await expect(tools.get("bash")!.execute({ command: "if [ -t 1 ]; then echo IS_TTY; else echo NO_TTY; fi" }, signal))
      .resolves.toContain("NO_TTY");
  });

  it("runs and observes background commands", async () => {
    const { tools, signal } = await setup();
    const started = await tools.get("bash")!.execute({ command: "printf bg-ok", background: true }, signal);
    const id = started.split(" ")[2]!;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const status = JSON.parse(await tools.get("get_background_task")!.execute({ task_id: id }, signal));
    expect(status.status).toBe("done");
    expect(status.output).toBe("bg-ok");
  });

  it("automatically moves a long-lived foreground command to the background", async () => {
    const { tools, signal } = await setup();
    const started = await tools.get("bash")!.execute({ command: "node -e 'setInterval(() => {}, 1000)'" }, signal);
    const id = started.match(/background task ([^ ]+)/)?.[1];
    expect(id).toBeTruthy();
    const status = JSON.parse(await tools.get("get_background_task")!.execute({ task_id: id }, signal));
    expect(status.status).toBe("running");
    await expect(tools.get("stop_background_task")!.execute({ task_id: id }, signal)).resolves.toContain("stopping");
  }, 20_000);
});

describe("shell exit codes", () => {
  it("reports a non-zero exit as data instead of failing the tool", async () => {
    const { tools, signal } = await setup();
    // These all exit non-zero by design during ordinary work; treating them as
    // TOOL ERROR made the timeline look broken and misled the model.
    for (const [command, code] of [["grep -q needle nope.txt", 2], ["test -f missing.txt", 1], ["command -v nope-not-real", 1]]) {
      const result = await tools.get("bash")!.execute({ command }, signal);
      expect(result, command).toContain(`[exit code: ${code}]`);
    }
  });

  it("keeps the output alongside the exit code", async () => {
    const { tools, signal } = await setup();
    const result = await tools.get("bash")!.execute({ command: "printf 'some output'; exit 4" }, signal);
    expect(result).toContain("some output");
    expect(result).toContain("[exit code: 4]");
  });

  it("adds no marker for a successful command", async () => {
    const { tools, signal } = await setup();
    const result = await tools.get("bash")!.execute({ command: "printf clean" }, signal);
    expect(result).toBe("clean");
    expect(result).not.toContain("exit code");
  });

  it("still fails the tool when the command cannot run at all", async () => {
    const { tools, signal } = await setup();
    await expect(tools.get("bash")!.execute({ command: "sleep 5", timeout: 1 }, signal)).rejects.toThrow(/timed out/);
  });
});
