import { describe, expect, it } from "vitest";
import { assessShellCommand, defaultSandboxSettings, resolveSandboxBackend, shellPathTokens, wrapWithBackend } from "./sandbox.js";

const soft = defaultSandboxSettings();

describe("sandbox soft policy", () => {
  it("blocks destructive host commands on linux and windows", () => {
    expect(assessShellCommand("rm -rf /", "/tmp/ws", soft)).toMatch(/blocked/);
    expect(assessShellCommand("rm -rf ~/docs", "/tmp/ws", soft)).toMatch(/blocked/);
    expect(assessShellCommand("mkfs.ext4 /dev/sda1", "/tmp/ws", soft)).toMatch(/blocked/);
    expect(assessShellCommand("format C:", "/tmp/ws", soft)).toMatch(/blocked/);
  });

  it("allows ordinary workspace builds", () => {
    expect(assessShellCommand("npm test -- --runInBand", "/tmp/ws", soft)).toBeNull();
    expect(assessShellCommand("git status --short", "/tmp/ws", soft)).toBeNull();
    expect(assessShellCommand("npm run build 2>&1 | head -n 50", "/tmp/ws", soft)).toBeNull();
  });

  it("blocks redirects outside the workspace while allowing /dev/null", () => {
    expect(assessShellCommand("echo hi > /etc/cron.d/x", "/tmp/ws", soft)).toMatch(/blocked/);
    expect(assessShellCommand("echo hi > /dev/null", "/tmp/ws", soft)).toBeNull();
    expect(assessShellCommand("rm /tmp/other/file", "/tmp/ws", { ...soft, allowOutsideWorkspace: false })).toMatch(/blocked/);
  });

  it("allows in-workspace relative paths that contain a separator", () => {
    // Regression: the escape check used to scan for "/" anywhere in the command,
    // so the "/" in an ordinary relative path looked absolute and `cp`, `mv`,
    // `mkdir` and `chmod` were rejected inside the workspace.
    for (const command of [
      "chmod +x ./build_lnk.sh",
      "chmod +x dist/cli.js",
      "chmod +x scripts/tui-smoke.py",
      "mkdir -p src/new/dir",
      "cp src/a.ts src/b.ts",
      "mv ./tmp.txt ./out.txt",
      "tee build.log",
      "grep -n foo src/app.ts",
    ]) {
      expect(assessShellCommand(command, "/tmp/ws", soft), command).toBeNull();
    }
  });

  it("still blocks writes that leave the workspace, relative or absolute", () => {
    for (const command of [
      "cp foo ../other/x",
      "chmod +x ../other/script.sh",
      "cp foo /etc/x",
      "echo hi > /tmp/x",
      "cp a.txt /usr/local/bin/x",
      "sh -c 'chmod +x /opt/x'",
      "bash -c \"cp a /etc/b\"",
      "cp --target=/etc/x .",
    ]) {
      expect(assessShellCommand(command, "/tmp/ws", soft), command).toMatch(/path escapes workspace/);
    }
  });

  it("never mistakes a URL path for a filesystem path", () => {
    // API work is full of `curl https://host/api/x`; the URL tail used to be
    // extracted as "/api/x" and judged as escaping the workspace.
    for (const command of [
      "curl -sS https://api.github.com/repos/o/r/releases",
      "curl -sS https://example.com/api/releases > rel.json",
      "curl -X POST 'https://example.com/api/releases' -d '{\"tag\":\"v1\"}'",
      "curl -sS --url=https://example.com/api/releases",
      "curl -sS -d '{\"redirect\":\"/api/releases\"}' https://example.com/x > out.json",
      "curl -sS -d '{\"path\": /api/releases}' https://example.com/x > out.json",
      "gh api /repos/o/r/releases",
    ]) {
      expect(assessShellCommand(command, "/tmp/ws", soft), command).toBeNull();
    }
  });

  it("keeps reads of absolute paths outside the workspace allowed", () => {
    expect(assessShellCommand("cat /etc/hosts", "/tmp/ws", soft)).toBeNull();
    expect(assessShellCommand("grep -n localhost /etc/hosts", "/tmp/ws", soft)).toBeNull();
  });

  it("extracts path tokens from quoted sub-commands and assignments", () => {
    // Only path-like tokens are returned; a bare relative name resolves inside
    // the workspace and needs no check.
    expect(shellPathTokens("cp a /etc/b")).toEqual(["/etc/b"]);
    expect(shellPathTokens("sh -c 'chmod +x /opt/x'")).toEqual(["/opt/x"]);
    expect(shellPathTokens("cmd --out=/tmp/x")).toEqual(["/tmp/x"]);
    expect(shellPathTokens("./build_lnk.sh")).toEqual(["./build_lnk.sh"]);
    expect(shellPathTokens("cp ../outside/x dist/y")).toEqual(["../outside/x", "dist/y"]);
  });

  it("never scans heredoc bodies as shell arguments", () => {
    // Regression: the heredoc body was tokenized line by line, so Python
    // arithmetic `a = (3)/2` contributed "/2" and a `>` in prose looked like a
    // redirect. Writing any script with `cat > x.py << 'PYEOF'` failed with
    // "path escapes workspace: /".
    const nl = String.fromCharCode(10);
    for (const command of [
      `cat > pE.py << 'PYEOF'${nl}a = (3)/2${nl}b = 3/(2)${nl}print(a, b)${nl}PYEOF${nl}python3 pE.py; rm pE.py`,
      `cat > probe.py << PYEOF${nl}if a > b:${nl}    print(1/2)${nl}PYEOF${nl}python3 probe.py`,
      `cat > t.sh <<-HEREDOC${nl}\techo "x / y > z"${nl}HEREDOC${nl}bash t.sh`,
    ]) {
      expect(assessShellCommand(command, "/tmp/ws", soft), command).toBeNull();
    }
    // A heredoc written outside the workspace is still blocked.
    expect(assessShellCommand(`cat > /etc/x << 'PYEOF'${nl}a = 1${nl}PYEOF`, "/tmp/ws", soft)).toMatch(/blocked/);
  });

  it("does not treat 2>/dev/null as a write", () => {
    // Regression: `/>/` matched the `2>` in `2>/dev/null`, so a plain read of
    // an absolute path became "path escapes workspace".
    for (const command of [
      "grep -rn foo --include=*.py . 2>/dev/null | head -20",
      "cat /etc/hosts 2>/dev/null",
      "ls /proc/version 2>/dev/null",
    ]) {
      expect(assessShellCommand(command, "/tmp/ws", soft), command).toBeNull();
    }
    expect(assessShellCommand("cat foo > /etc/x 2>/dev/null", "/tmp/ws", soft)).toMatch(/blocked/);
  });

  it("optionally blocks network egress", () => {
    const noNet = { ...soft, allowNetwork: false };
    expect(assessShellCommand("curl https://example.com", "/tmp/ws", noNet)).toMatch(/network/);
    expect(assessShellCommand("npm test", "/tmp/ws", noNet)).toBeNull();
  });

  it("honours custom deny patterns", () => {
    const custom = { ...soft, denyPatterns: ["kubectl.*prod"] };
    expect(assessShellCommand("kubectl delete -n prod", "/tmp/ws", custom)).toMatch(/deny rule/);
  });
});

describe("sandbox OS backends", () => {
  it("wraps bwrap with confinement flags and optional net cut", () => {
    const wrapped = wrapWithBackend("/bin/bash", ["-lc", "npm test"], "/tmp/ws",
      { ...soft, backend: "bwrap", allowNetwork: false });
    // bwrap may be absent here; resolveSandboxBackend decides. Force the shape instead:
    if (wrapped.executable === "bwrap") {
      expect(wrapped.args).toContain("--unshare-net");
      expect(wrapped.args).toContain("--die-with-parent");
      expect(wrapped.args).toContain("--tmpfs");
    } else {
      expect(wrapped).toEqual({ executable: "/bin/bash", args: ["-lc", "npm test"] });
    }
    expect(["bwrap", "docker", "none"]).toContain(resolveSandboxBackend({ ...soft, backend: "auto" }));
  });

  it("builds a docker invocation only with an explicit image", () => {
    const withoutImage = wrapWithBackend("/bin/bash", ["-lc", "x"], "/tmp/ws",
      { ...soft, backend: "docker", dockerImage: "" });
    expect(withoutImage.executable).toBe("/bin/bash");
    const strict = { ...soft, mode: "strict" as const, backend: "docker" as const, dockerImage: "" };
    expect(() => wrapWithBackend("/bin/bash", ["-lc", "x"], "/tmp/ws", strict)).toThrow(/not available/);
  });
});
