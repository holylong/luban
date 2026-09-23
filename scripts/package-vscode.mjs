#!/usr/bin/env node
// Package editors/vscode into a .vsix (which is a zip with [Content_Types].xml).
// Prefers the system `zip`, falls back to `python3 -m zipfile`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "editors", "vscode");

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

async function commandAvailable(command, probe) {
  try {
    await run(command, probe, root);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!existsSync(join(root, "extension.js")) || !existsSync(join(root, "README.md"))) {
    throw new Error("editors/vscode must contain package.json, extension.js and README.md");
  }
  const out = join(root, `luban-${manifest.version}.vsix`);
  const contentTypes = `<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".vsixmanifest" ContentType="text/xml"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".xml" ContentType="text/xml"/></Types>`;
  await writeFile(join(root, "[Content_Types].xml"), `${contentTypes}\n`);
  const files = ["package.json", "extension.js", "README.md", "[Content_Types].xml", "extension.vsixmanifest"];
  const manifestXml = `<?xml version="1.0" encoding="utf-8"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="luban" Version="${manifest.version}" Publisher="${manifest.publisher || "luban"}"/><DisplayName>${manifest.displayName || manifest.name}</DisplayName><Description>${manifest.description || ""}</Description><Categories>${(manifest.categories || []).join(",")}</Categories><Tags></Tags><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="${(manifest.engines || {}).vscode || "^1.90.0"}"/></Properties></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="package.json" Addressable="true"/></Assets></PackageManifest>`;
  await writeFile(join(root, "extension.vsixmanifest"), `${manifestXml}\n`);
  try {
    if (await commandAvailable("zip", ["-v"])) {
      await run("zip", ["-FS", "-q", "-r", out, ...files], root);
    } else if (await commandAvailable("python3", ["--version"])) {
      const script = `import sys, zipfile; outs, srcs = sys.argv[1], sys.argv[2:];\nwith zipfile.ZipFile(outs, "w", zipfile.ZIP_DEFLATED) as z:\n    [z.write(s, s) for s in srcs]\n`;
      await run("python3", ["-c", script, out, ...files], root);
    } else {
      throw new Error("need `zip` or `python3` to build the .vsix");
    }
    process.stdout.write(`vsix: ${out}\n`);
  } finally {
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "[Content_Types].xml"), { force: true });
    await rm(join(root, "extension.vsixmanifest"), { force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
