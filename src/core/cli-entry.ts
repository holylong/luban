/* Which file is actually running: the answer `process.argv[1]` does not give.
 *
 * npm installs a package's executable as a symlink (`bin/luban` → `../lib/
 * node_modules/luban/dist/cli.js`) and some distributions wrap it in a shell
 * script. Node keeps whatever path the shell used in `process.argv[1]`, so a
 * symlinked launcher looks like `…/bin/luban` — no `.js` extension, and a
 * `realpath` away from the compiled CLI that detached children must be spawned
 * from. Everything that starts a daemon, a bot worker or a LaunchAgent needs
 * the resolved file, not the alias.
 */
import { realpathSync } from "node:fs";

/** Follow launcher symlinks; fall back to the given path when it does not exist. */
export function resolveCliPath(argv1: string | undefined): string | undefined {
  if (!argv1) return undefined;
  try {
    return realpathSync(argv1);
  } catch {
    // A path that is not on disk cannot be resolved, but it may still be the
    // name of the file a caller wants to talk about (tests do this on purpose).
    return argv1;
  }
}

/** The compiled CLI that can be handed a subcommand, never a dev loader. */
export function compiledCliEntry(argv1: string | undefined = process.argv[1]): string | undefined {
  const resolved = resolveCliPath(argv1);
  return resolved && /\.(?:c|m)?js$/u.test(resolved) ? resolved : undefined;
}
