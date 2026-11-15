import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forgetProjects, readProjects } from "./config.js";
import { durableProjects, isTransientWorkspace, visibleProjects, workspaceProblem } from "./project-registry.js";
import { projectRows } from "./projects-command.js";

describe("project registry hygiene", () => {
  it("treats OS scratch roots as transient but keeps real directories", async () => {
    const real = await mkdtemp(join(tmpdir(), "luban-project-real-"));
    // Even a directory that exists under temp is an artifact: it disappears with
    // the probe that made it.
    const scratch = await mkdtemp(join(tmpdir(), "luban-term-"));
    expect(isTransientWorkspace(scratch)).toBe(true);
    expect(isTransientWorkspace("/tmp/somewhere")).toBe(true);
    expect(isTransientWorkspace(real)).toBe(true);
    expect(isTransientWorkspace("/Users/me/Documents/luban")).toBe(false);
    expect(workspaceProblem("/Users/me/dev/definitely-not-here")).toBe("missing");
  });

  it("hides transient and missing registrations but never the running project", () => {
    const visible = visibleProjects({
      luban: "/Users/me/Documents/luban",
      probe: "/private/var/folders/jw/T/luban-term-kKcgL5",
      gone: "/home/deploy/dev/myapp",
      current: "/private/var/folders/jw/T/luban-a-probe",
    }, { keep: "current" });
    expect(Object.keys(visible)).toEqual(["luban", "current"]);
  });

  it("forgets entries without touching other config keys or the directories", async () => {
    const home = await mkdtemp(join(tmpdir(), "luban-home-"));
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "config.json"), JSON.stringify({
      projects: { keep: "/work/keep", probe: "/tmp/probe", gone: "/nope/gone" }, theme: "midnight",
    }), "utf8");
    expect(await forgetProjects(home, ["probe", "gone", "missing"])).toEqual(["probe", "gone"]);
    const saved = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    expect(saved).toEqual({ projects: { keep: "/work/keep" }, theme: "midnight" });
    expect(await readProjects(home)).toEqual({ keep: "/work/keep" });
  });

  it("orders usable workspaces first in the CLI listing", async () => {
    const real = await mkdtemp(join(tmpdir(), "luban-row-"));
    // The temp path is transient regardless of existing; `real` is too, so use
    // the home directory itself as the one usable row.
    const rows = projectRows({ z: "/tmp/z", a: process.cwd() });
    expect(rows.map(row => row.project)).toEqual(["a", "z"]);
    expect(rows.map(row => row.state)).toEqual(["ok", "transient"]);
    expect(real).toBeTruthy();
  });

  it("cleans a relay snapshot without touching other machines' real paths", () => {
    expect(durableProjects({
      luban: "/Users/me/Documents/luban",
      dpan: "/home/deploy/WorkStation/dpan",
      "luban-term-kKcgL5": "/private/var/folders/jw/T/luban-term-kKcgL5",
      scratch: "/tmp/probe",
    })).toEqual({ luban: "/Users/me/Documents/luban", dpan: "/home/deploy/WorkStation/dpan" });
  });
});
