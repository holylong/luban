import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { releasePlan } from './release.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const version = JSON.parse(read('package.json')).version;

test('the desktop release plans both the portable ZIP and the setup installer', () => {
  const plan = releasePlan(['--kind', 'desktop'], 'win32', 'x64', version);
  assert.deepEqual(plan.artifacts, [
    `luban-desktop-${version}-win-x64.zip`,
    `luban-desktop-${version}-win-x64-setup.exe`,
  ]);
});

test('the Inno Setup script installs the portable payload for the current user', () => {
  const script = read('packaging/windows/desktop.iss');
  // Per-user install: no elevation, no Program Files.
  assert.ok(script.includes('PrivilegesRequired=lowest'));
  assert.ok(script.includes('{localappdata}\\Programs\\luban'));
  assert.ok(script.includes('Source: "{#Payload}\\*"'));
  assert.ok(script.includes('OutputBaseFilename=luban-desktop-{#AppVersion}-win-x64-setup'));
  // release/install-smoke.cmd looks for this name after a silent install.
  assert.ok(script.includes('luban-desktop.cmd'));
  // A running desktop shell must survive an upgrade of its files.
  assert.ok(script.includes('CloseApplications=no'));
  assert.ok(script.includes('RestartApplications=no'));
});

test('packaging desktop compiles the installer instead of only zipping', () => {
  const windows = read('scripts/package-windows.mjs');
  assert.ok(windows.includes('packaging", "windows", "desktop.iss"'));
  assert.ok(windows.includes('isccPath()'));
  assert.ok(!windows.includes('forge-desktop'));
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

test('CI prepares the compiler before building the desktop installer', () => {
  const ci = read('.github/workflows/release.yml');
  assert.ok(ci.includes('node scripts/ensure-inno.mjs'));
  assert.ok(ci.indexOf('node scripts/ensure-inno.mjs') < ci.indexOf('name: Build Windows ZIPs and Desktop installer'));
});
