/**
 * What the terminal we are drawing on can actually do.
 *
 * The awkward case is a remote shell. `ssh` forwards `TERM` but, unless the
 * host's `AcceptEnv` and the client's `SendEnv` agree, not `COLORTERM` or
 * `TERM_PROGRAM`. `supports-color` then falls back to whatever `TERM` names:
 * 16 colors for a plain `xterm`, none at all when `TERM` is empty — so a
 * workbench that looks styled on the laptop turns into flat text after
 * `ssh ubuntu`. Every virtual terminal seen over ssh in the last decade does
 * 256 colors, so a remote TTY with no better information gets 256 instead of a
 * downgrade, and `NO_COLOR` / `FORCE_COLOR` / `TERM=dumb` still win.
 */
export interface TerminalCapabilities {
  /** 0 none, 1 the 16 ANSI colors, 2 the 256-color cube, 3 24-bit color. */
  colorLevel: 0 | 1 | 2 | 3;
  /** Hex colors may be emitted as `38;2;r;g;b` rather than approximated. */
  trueColor: boolean;
  /** Seen through ssh (or a similar remote shell) rather than a local console. */
  remote: boolean;
  /** One line explaining the choice, for `LUBAN_TERM_INFO=1`. */
  reason: string;
}

/** Values people use to mean "I did not really mean NO_COLOR". */
const NO_COLOR_OPT_OUT = new Set(["0", "false"]);

function levelFromForceColor(value: string | undefined): 0 | 1 | 2 | 3 | undefined {
  if (value === undefined) return undefined;
  // chalk's own convention: 0 disables, true/1 basic, 2 256, 3 truecolor.
  if (value === "true") return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  if (parsed <= 0) return 0;
  return Math.min(3, Math.trunc(parsed)) as 1 | 2 | 3;
}

/**
 * Resolve the capability set from environment and TTY state.
 *
 * @param env Process environment (injected by tests).
 * @param options Whether the drawing stream is a TTY.
 * @returns Capabilities plus the reason the color level came out that way.
 */
export function detectTerminalCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  options: { isTTY: boolean } = { isTTY: Boolean(process.stdout.isTTY) },
): TerminalCapabilities {
  const term = env.TERM ?? "";
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  const finish = (colorLevel: 0 | 1 | 2 | 3, reason: string): TerminalCapabilities => ({
    colorLevel,
    trueColor: colorLevel === 3,
    remote,
    reason,
  });

  if (!options.isTTY) return finish(0, "output is not a terminal");
  if (term === "dumb") return finish(0, "TERM=dumb");
  // The spec disables color for any NO_COLOR value, including an empty one;
  // "0"/"false" are the widespread exception people use to turn it back on.
  if (env.NO_COLOR !== undefined && !NO_COLOR_OPT_OUT.has(env.NO_COLOR.toLowerCase())) return finish(0, "NO_COLOR is set");
  const forced = levelFromForceColor(env.FORCE_COLOR);
  if (forced !== undefined) return finish(forced, `FORCE_COLOR=${env.FORCE_COLOR}`);
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return finish(3, `COLORTERM=${env.COLORTERM}`);
  if (/256color/i.test(term)) return finish(2, `TERM=${term}`);
  if (remote) return finish(2, `remote shell (TERM=${term || "unset"}) without COLORTERM`);
  if (env.COLORTERM) return finish(1, `COLORTERM=${env.COLORTERM}`);
  return finish(1, `TERM=${term || "unset"}`);
}

let cached: TerminalCapabilities | undefined;

/**
 * Detected capabilities for this process, computed once.
 *
 * @returns The capability set for `process.stdout`.
 */
export function terminalCapabilities(): TerminalCapabilities {
  cached ??= detectTerminalCapabilities();
  return cached;
}

/**
 * Detect the capabilities and report them when asked.
 *
 * Applying the level to the color library is the caller's job (`terminal-boot`
 * sets `chalk.level`) because `FORCE_COLOR` is the wrong tool: chalk turns any
 * `FORCE_COLOR` value into 24-bit output, and a 256-color terminal renders
 * `38;2;r;g;b` as no color at all — the exact symptom this is fixing.
 *
 * @param env Environment to read (defaults to `process.env`).
 * @param options Whether the drawing stream is a TTY.
 * @returns The capabilities that were detected.
 */
export function applyTerminalCapabilities(
  env: NodeJS.ProcessEnv = process.env,
  options: { isTTY: boolean } = { isTTY: Boolean(process.stdout.isTTY) },
): TerminalCapabilities {
  const capabilities = detectTerminalCapabilities(env, options);
  if (env.LUBAN_TERM_INFO === "1") {
    process.stderr.write(
      `terminal: TERM=${env.TERM || "(unset)"} COLORTERM=${env.COLORTERM || "(unset)"} ssh=${capabilities.remote ? "yes" : "no"}`
      + ` color=${capabilities.colorLevel} (${capabilities.reason})\n`,
    );
  }
  return capabilities;
}
