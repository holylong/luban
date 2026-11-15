import { describe, expect, it } from "vitest";
import { mobileProject, mobileProjects, scratchWorkspace } from "./mobile-project";

describe("phone workspace selection", () => {
  const node = { project: "timeagent-cpp", workspace: "D:\\WorkStation\\timeagent-cpp", projects: { myapp: "D:\\myapp", "timeagent-cpp": "D:\\WorkStation\\timeagent-cpp" } };
  it("puts the PC's open workspace first and keeps other registered projects", () => {
    expect(mobileProject(node, "")).toBe("timeagent-cpp");
    expect(mobileProjects(node)).toEqual({ "timeagent-cpp": node.workspace, myapp: "D:\\myapp" });
  });
  it("keeps registered projects but drops an id from another device", () => {
    expect(mobileProject(node, "luban")).toBe("timeagent-cpp");
    expect(mobileProject(node, "myapp")).toBe("myapp");
  });
  it("does not hide a real workspace named myapp", () => {
    expect(mobileProjects({ ...node, project: "myapp", workspace: "D:\\real\\myapp" })).toEqual({
      myapp: "D:\\real\\myapp", "timeagent-cpp": node.workspace,
    });
  });
  it("lets the running workspace override a stale config path", () => {
    expect(mobileProjects({ project: "real", workspace: "/real", projects: { real: "/stale" } })).toEqual({ real: "/real" });
  });
  it("supports legacy nodes without current workspace metadata", () => {
    expect(mobileProject({ projects: { legacy: "/work" } }, "")).toBe("legacy");
    expect(mobileProjects()).toEqual({});
  });
});

describe("scratch workspaces", () => {
  it("recognises the temp directories probes leave in a node's config", () => {
    expect(scratchWorkspace("/private/var/folders/jw/prg5wwlx7gv3c37hf97v858h0000gn/T/luban-term-kKcgL5")).toBe(true);
    expect(scratchWorkspace("/var/folders/x/T/luban-a-uafP5D")).toBe(true);
    expect(scratchWorkspace("/tmp/luban-b-s9c5n3")).toBe(true);
    expect(scratchWorkspace("/private/tmp/ws")).toBe(true);
    expect(scratchWorkspace("C:\\Users\\me\\AppData\\Local\\Temp\\luban-term-1")).toBe(true);
  });
  it("leaves real workspaces and look-alike names alone", () => {
    expect(scratchWorkspace("/Users/me/Documents/luban")).toBe(false);
    expect(scratchWorkspace("/home/deploy/dev/myapp")).toBe(false);
    expect(scratchWorkspace("/Users/me/tmp/app")).toBe(false);
    expect(scratchWorkspace("/var/foldersx/app")).toBe(false);
    expect(scratchWorkspace("/tmpish")).toBe(false);
  });
});
