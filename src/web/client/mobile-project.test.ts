import { describe, expect, it } from "vitest";
import { mobileProject, mobileProjects } from "./mobile-project";

describe("phone workspace selection", () => {
  const node = { project: "timeagent-cpp", workspace: "D:\\WorkStation\\timeagent-cpp", projects: { myapp: "D:\\myapp", "timeagent-cpp": "D:\\WorkStation\\timeagent-cpp" } };
  it("uses the PC's open workspace instead of a configured example", () => {
    expect(mobileProject(node, "")).toBe("timeagent-cpp");
    expect(mobileProjects(node)).toEqual({ "timeagent-cpp": node.workspace });
  });
  it("drops a project carried from another device", () => {
    expect(mobileProject(node, "luban")).toBe("timeagent-cpp");
    expect(mobileProject(node, "myapp")).toBe("timeagent-cpp");
  });
  it("does not hide a real workspace named myapp", () => {
    expect(mobileProjects({ ...node, project: "myapp", workspace: "D:\\real\\myapp" })).toEqual({ myapp: "D:\\real\\myapp" });
  });
  it("supports legacy nodes without current workspace metadata", () => {
    expect(mobileProject({ projects: { legacy: "/work" } }, "")).toBe("legacy");
    expect(mobileProjects()).toEqual({});
  });
});
