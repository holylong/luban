import { describe, expect, it } from "vitest";
import { mobileProject, mobileProjects } from "./mobile-project";

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
