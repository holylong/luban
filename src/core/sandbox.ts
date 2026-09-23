import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface SandboxSettings {
  /** soft = static checks only; strict also requires an OS backend when configured; off disables checks. */
  mode: "soft" | "strict" | "off";
  /** When false, commands that clearly access the network are rejected unless explicitly allowed. */
  allowNetwork: boolean;
  /** When false, absolute paths outside the workspace are rejected. */
  allowOutsideWorkspace: boolean;
  /** Optional OS isolation backend. auto = bwrap when present, else none (docker only with explicit image). */
  backend: "auto" | "bwrap" | "docker" | "none";
  /** Docker image used when backend is docker (never pulled implicitly). */
  dockerImage: string;
  /** Extra command regexes (case-insensitive) that are always denied. */
  denyPatterns: string[];
}

export function defaultSandboxSettings(): SandboxSettings {
  return { mode: "soft", allowNetwork: true, allowOutsideWorkspace: false, backend: "none", dockerImage: "", denyPatterns: [] };
}

/** Resolve the effective OS backend: auto prefers bwrap, then docker-with-image, else none. */
export function resolveSandboxBackend(sandbox: SandboxSettings): "bwrap" | "docker" | "none" {
  if (sandbox.backend === "bwrap") return sandboxBackendAvailable("bwrap") ? "bwrap" : "none";
  if (sandbox.backend === "docker") return sandbox.dockerImage && sandboxBackendAvailable("docker") ? "docker" : "none";
  if (sandbox.backend === "auto") {
    if (process.platform !== "win32" && sandboxBackendAvailable("bwrap")) return "bwrap";
    if (sandbox.dockerImage && sandboxBackendAvailable("docker")) return "docker";
    return "none";
  }
  return "none";
}

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+[^;|&]*-(?:r|f)[rf]*\s+(?:\/|~|\$HOME|\$env:)/i,
  /(^|[;|&])\s*rm\s+-rf?\s+\/\s*($|[;|&])/,
  /\bmkfs\b/i,
  /\bdd\s+[^;|&]*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|\:&\s*\}\s*;/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bformat\s+[a-z]:/i,
  /\brd\s+\/s\s+[a-z]:\\/i,
  /\bdel\s+\/f\s+\/s\s+[a-z]:\\/i,
  />\s*\/dev\/sd[a-z]/i,
];

const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\binvoke-webrequest\b/i,
  /\binvoke-restmethod\b/i,
  /\bnc\s+-/i,
  /\bnetcat\b/i,
  /\bssh\s+\S+@/i,
  /\bscp\s+/i,
  /\brsync\s+.*::/i,
  /\bftp\s+\S+/i,
];

const OUTSIDE_WRITE_PATTERNS: RegExp[] = [
  />\s*\/etc\//,
  />\s*\/usr\//,
  />\s*\/bin\//,
  />\s*\/sbin\//,
  />\s*\/boot\//,
  />\s*\/root\//,
  />\s*[A-Za-z]:\\Windows\\/i,
  />\s*[A-Za-z]:\\Program Files/i,
];

/**
 * Heredoc bodies are file content, not shell arguments. Without this, a
 * `cat > x.py << 'PYEOF' ... PYEOF` was scanned line by line, so Python
 * arithmetic (`a = (3)/2`) contributed a "/2" token and prose containing ">"
 * looked like a redirect, blocking the ordinary way of writing any script.
 */
export function stripHeredocs(command: string): string {
  return command.replace(/<<-?[ \t]*(["']?)(\w+)\1[\s\S]*?\n[ \t]*\2(?![\w])(?=$|[\s;|&()<>])/gu, " ");
}

/**
 * True when the command redirects stdout to a file. `2>` and `&>` merge the
 * error stream and `/dev/null` is not a file, so neither counts as a write;
 * the previous `/>/` test turned every `2>/dev/null` into "this command
 * writes", which then blocked plain reads of /etc or /proc paths.
 */
function hasOutputRedirect(command: string): boolean {
  for (const match of command.matchAll(/(^|[\s;&|(])(\d*|&)?>{1,2}[ \t]*(\S+)/gu)) {
    if (match[2] === "2" || match[2] === "&") continue;
    if (/^(?:\/dev\/null|NUL)$/i.test(match[3])) continue;
    return true;
  }
  return false;
}

/**
 * Path-like tokens in a shell command: quoted strings and bare words that are
 * absolute, start with `~`/`$HOME`, or contain a separator. Splits on the usual
 * shell metacharacters so `--out=/tmp/x` and `cp a b/c` both yield tokens.
 */
export function shellPathTokens(command: string): string[] {
  // A URL path is not a filesystem path. Without this, `curl https://host/api/x`
  // could contribute "/api/x" and be judged as escaping the workspace, which is
  // exactly what an API-calling task does constantly.
  const masked = command.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`;|&)]*/gu, " ");
  const words = masked.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&()<>]+/gu) ?? [];
  const tokens: string[] = [];
  for (const word of words) {
    const quoted = /^["']/u.test(word);
    const token = word.replace(/^["']|["']$/gu, "");
    if (!token) continue;
    // A quoted argument can wrap a whole sub-command (`sh -c 'cp a /etc/b'`), so
    // its inside is split again; otherwise an absolute path hidden there would
    // be resolved as a harmless relative one.
    for (const piece of token.split(/[\s=]+/u)) {
      if (!piece) continue;
      // Reject fragments of structured text (JSON bodies, quoted prose). A real
      // path or option value has no quotes, braces, commas or colons.
      if (!/^[\w./~$@%+\-]+$/u.test(piece)) continue;
      const absolute = /^(?:[A-Za-z]:[\\/]|[\\/]|~|\$HOME)/u.test(piece);
      const relative = /[\\/]/u.test(piece);
      // Quoted text only contributes absolute paths: a bare `a/b` inside a
      // string is prose or a URL tail, not an argument the shell will resolve.
      if (absolute || (relative && !quoted)) tokens.push(piece);
    }
  }
  return tokens;
}

/** Best-effort static assessment. Returns a block reason, or null when allowed. */
export function assessShellCommand(command: string, workspace: string, sandbox: SandboxSettings): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "command is empty";
  if (sandbox.mode === "off") return null;
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) return `blocked by sandbox: destructive pattern matched (${pattern.source.slice(0, 48)}…)`;
  }
  for (const raw of sandbox.denyPatterns) {
    try {
      if (new RegExp(raw, "i").test(trimmed)) return `blocked by sandbox deny rule: ${raw}`;
    } catch {
      if (trimmed.toLowerCase().includes(String(raw).toLowerCase())) return `blocked by sandbox deny rule: ${raw}`;
    }
  }
  if (!sandbox.allowNetwork) {
    for (const pattern of NETWORK_PATTERNS) {
      if (pattern.test(trimmed)) return `blocked by sandbox: network access is disabled (matched ${pattern.source.slice(0, 32)}…)`;
    }
  }
  if (!sandbox.allowOutsideWorkspace) {
    // Heredoc bodies are written to disk as-is; they are never parsed by the
    // shell, so nothing inside them can redirect or touch a path.
    const stripped = stripHeredocs(trimmed);
    const writes = hasOutputRedirect(stripped);
    for (const pattern of OUTSIDE_WRITE_PATTERNS) {
      if (pattern.test(stripped)) return "blocked by sandbox: redirect outside the workspace is not allowed";
    }
    // Path tokens that resolve outside the workspace root.
    //
    // Every token is resolved against the workspace, so a relative path that
    // climbs out with ".." is caught just like an absolute one. The previous
    // version scanned for a "/" anywhere in the command, which made the "/" in
    // an ordinary relative path ("./build.sh", "dist/cli.js") look like an
    // absolute path and rejected `cp`, `mv`, `mkdir` and `chmod` inside the
    // workspace. Anchoring the scan to token boundaries alone would have lost
    // the "../outside" case, so tokens are parsed and resolved instead.
    const root = resolve(workspace);
    for (const token of shellPathTokens(stripped)) {
      if (/^\/dev\/null$/i.test(token) || /^NUL$/i.test(token)) continue;
      if (/^\/proc\/|\/sys\//.test(token) && !writes) continue;
      if (token.startsWith("~") || token.startsWith("$HOME")) continue; // handled by destructive rules; home reads stay allowed
      let resolved: string;
      try {
        resolved = resolve(root, token);
      } catch {
        return `blocked by sandbox: cannot resolve path ${token}`;
      }
      if (resolved !== root && !resolved.startsWith(`${root}/`) && !resolved.startsWith(`${root}\\`)) {
        // Reads of /tmp and system binaries stay allowed; writes/redirects do not.
        if (writes || /\b(rm|mv|cp|tee|chmod|chown|mkdir|rmdir|del|move|copy)\b/i.test(stripped)) {
          return `blocked by sandbox: path escapes workspace: ${token}`;
        }
      }
    }
  }
  return null;
}

export function sandboxBackendAvailable(backend: SandboxSettings["backend"]): boolean {
  if (backend === "bwrap") return existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap");
  if (backend === "docker") return existsSync("/usr/bin/docker") || existsSync("/usr/local/bin/docker");
  return false;
}

/** Wrap a shell command in an OS backend when one is explicitly configured and present. */
export function wrapWithBackend(
  executable: string,
  args: string[],
  workspace: string,
  sandbox: SandboxSettings,
): { executable: string; args: string[] } {
  const effective = sandbox.backend === "none" ? "none" : resolveSandboxBackend(sandbox);
  if (effective === "none") {
    if ((sandbox.backend === "bwrap" || sandbox.backend === "docker") && sandbox.mode === "strict") {
      throw new Error(`sandbox backend ${sandbox.backend} is not available`);
    }
    if (sandbox.backend === "auto" && sandbox.mode === "strict" && !sandboxBackendAvailable("bwrap") && !(sandbox.dockerImage && sandboxBackendAvailable("docker"))) {
      throw new Error("sandbox backend auto found neither bwrap nor docker; install bubblewrap or configure a docker image");
    }
    return { executable, args };
  }
  if (effective === "bwrap" && process.platform !== "win32") {
    // Real confinement: workspace RW; toolchain/CA certs read-only; fresh /tmp,
    // /proc, /dev; new pid/ipc/uts namespaces; network cut only when disallowed.
    // Host $HOME is NOT bound: tools must live in the workspace or /usr.
    const net = sandbox.allowNetwork ? [] : ["--unshare-net"];
    const roBind = (src: string, dest = src) => (existsSync(src) ? ["--ro-bind", src, dest] : []);
    return {
      executable: "bwrap",
      args: [
        ...roBind("/usr"), ...roBind("/bin"), ...roBind("/lib"), ...roBind("/lib64"),
        ...roBind("/opt"), ...roBind("/etc"), ...roBind("/run/ca-certificates"),
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--bind", workspace, workspace, "--chdir", workspace,
        "--die-with-parent", "--unshare-pid", "--unshare-ipc", "--unshare-uts", ...net,
        "--", executable, ...args,
      ],
    };
  }
  if (effective === "docker" && sandbox.dockerImage) {
    const net = sandbox.allowNetwork ? [] : ["--network", "none"];
    return {
      executable: "docker",
      args: ["run", "--rm", "-v", `${workspace}:${workspace}`, "-w", workspace, ...net, sandbox.dockerImage, executable, ...args],
    };
  }
  return { executable, args };
}
