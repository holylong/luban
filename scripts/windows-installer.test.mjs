import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releasePlan } from './release.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;

test('every Windows variant plans a portable ZIP and a setup installer', () => {
  for (const kind of ['cli', 'desktop', 'creator']) {
    assert.deepEqual(releasePlan(['--kind', kind], 'win32', 'x64', version).artifacts, [
      `luban-${kind}-${version}-win-x64.zip`,
      `luban-${kind}-${version}-win-x64-setup.exe`,
    ]);
  }
});

test('the installer script installs the portable payload for the current user', () => {
  const script = read('packaging/windows/installer.iss');
  // Per-user install: no elevation, no Program Files.
  assert.ok(script.includes('PrivilegesRequired=lowest'));
  assert.ok(script.includes('DefaultDirName={localappdata}\\Programs\\{#DirName}'));
  assert.ok(script.includes('Source: "{#Payload}\\*"'));
  // One script, three kinds: each gets its own AppId, directory and launcher.
  assert.ok(script.includes('#if Kind == "cli"'));
  assert.ok(script.includes('#elif Kind == "creator"'));
  assert.ok(script.includes('"luban-cli-" + AppVersion + "-win-x64-setup"'));
  assert.ok(script.includes('"luban-desktop-" + AppVersion + "-win-x64-setup"'));
  assert.ok(script.includes('"luban-creator-" + AppVersion + "-win-x64-setup"'));
  assert.ok(script.includes('luban-desktop.cmd'));
  assert.ok(script.includes('luban-creator.cmd'));
  // Only the CLI goes on PATH, and uninstall takes it back out.
  assert.ok(script.includes('RegWriteExpandStringValue'));
  assert.ok(script.includes('CurUninstallStepChanged'));
  // A running desktop shell must survive an upgrade of its files.
  assert.ok(script.includes('CloseApplications=no'));
  assert.ok(script.includes('RestartApplications=no'));
});

test('packaging compiles an installer for every variant instead of only zipping', () => {
  const windows = read('scripts/package-windows.mjs');
  assert.ok(windows.includes('packaging", "windows", "installer.iss"'));
  assert.ok(windows.includes('`/DKind=${kind}`'));
  assert.ok(windows.includes('isccPath()'));
  assert.ok(!windows.includes('forge-desktop'));
  assert.ok(!windows.includes('desktop.iss'), 'a desktop-only script must not come back');
  const ensure = read('scripts/ensure-inno.mjs');
  assert.ok(ensure.includes('innosetup-'));
  assert.ok(ensure.includes('ISCC.exe'));
  assert.ok(ensure.includes('LUBAN_ISCC'));
});

test('the installed shell resolves the bundled runtime beside desktop/', () => {
  const main = read('apps/desktop/main.cjs');
  assert.ok(main.includes('const bundledRoot = resolve(__dirname, "..");'));
  assert.ok(main.includes('join(bundledRoot, "app", "dist", "cli.js")'));
});

test('CI prepares the compiler before building the Windows installers', () => {
  const ci = read('.github/workflows/release.yml');
  assert.ok(ci.includes('node scripts/ensure-inno.mjs'));
  const prepare = ci.indexOf('node scripts/ensure-inno.mjs');
  const build = ci.indexOf('name: Build Windows packages and installers');
  assert.ok(build > 0, 'the Windows build step must be named');
  assert.ok(prepare < build, 'the compiler must be prepared first');
});
