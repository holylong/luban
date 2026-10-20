import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test.each([undefined, "", "development", "test", "production"])("initializes React environment before loading it (%s)", (selected) => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  if (selected !== undefined) env.NODE_ENV = selected;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    await import('./src/runtime-env.ts');
    const { createElement } = await import('react');
    console.log(JSON.stringify({ env: process.env.NODE_ENV, frozen: Object.isFrozen(createElement('test')) }));
  `], { cwd: process.cwd(), env, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const expected = selected || "production";
  expect(JSON.parse(result.stdout)).toEqual({ env: expected, frozen: expected !== "production" });
});

test("CLI loads environment first without an earlier generated JSX import", () => {
  const source = readFileSync(new URL('./cli.tsx', import.meta.url), "utf8");
  expect(source.split('\n')[1]).toBe('import "./runtime-env.js";');
  expect(source).not.toContain('<App ');
});
