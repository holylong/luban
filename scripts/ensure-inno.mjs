/** Locate Inno Setup 6's command-line compiler for the Desktop installer, and
 * install it into release/.tools when the machine has none.
 *
 * The compiler is the only external tool the Windows release needs; without it
 * the Desktop build must fail loudly instead of quietly shipping a ZIP alone.
 * Run this script directly on a fresh machine or CI runner; `isccPath()` is the
 * import-safe half that `scripts/package-windows.mjs` uses.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tools = join(root, "release", ".tools");
const target = join(tools, "inno");
const INNO_VERSION = "6.2.2";
const INNO_URL = `https://files.jrsoftware.org/is/6/innosetup-${INNO_VERSION}.exe`;

/** @returns {string | undefined} path to ISCC.exe, wherever it was found */
export function isccPath() {
  const candidates = [
    process.env.LUBAN_ISCC,
    join(target, "ISCC.exe"),
    join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Inno Setup 6", "ISCC.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Inno Setup 6", "ISCC.exe"),
    join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
  ].filter(Boolean);
  return candidates.find(file => existsSync(file));
}

/** The vendor's own signed setup, run silently into release/.tools so the
 * compiler stays out of Program Files on a CI runner. */
async function installCompiler() {
  mkdirSync(tools, { recursive: true });
  const download = join(tools, `innosetup-${INNO_VERSION}.exe`);
  if (!existsSync(download)) {
    process.stdout.write(`Downloading Inno Setup ${INNO_VERSION}\n`);
    const response = await fetch(INNO_URL);
    if (!response.ok) throw new Error(`Inno Setup download failed (${response.status}); install it manually and set LUBAN_ISCC`);
    writeFileSync(download, Buffer.from(await response.arrayBuffer()));
  }
  process.stdout.write(`Installing Inno Setup ${INNO_VERSION} into ${target}\n`);
  const install = spawnSync(download, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${target}`], {
    stdio: ["ignore", "inherit", "inherit"],
    windowsHide: true,
  });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(`Inno Setup installer failed (${install.status})`);
}

export async function ensureInnoCompiler() {
  const found = isccPath();
  if (found) return found;
  await installCompiler();
  const installed = isccPath();
  if (!installed) throw new Error("Inno Setup installed but ISCC.exe is missing; set LUBAN_ISCC");
  return installed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.stdout.write(`ISCC: ${await ensureInnoCompiler()}\n`);
}
