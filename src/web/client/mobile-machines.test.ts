import { describe, expect, it } from "vitest";
import { groupRelayMachines, machineWorkspaceRoutes, type RelayMachineInstance } from "./mobile-machines";

function instance(fields: Partial<RelayMachineInstance> = {}): RelayMachineInstance {
  return {
    id: "n-one", device_id: "dev-0123456789abcdef-1111111111111111", name: "work-mac · luban",
    version: "2.5.15", workspace: "/Users/me/luban", projects: { luban: "/Users/me/luban", cooler: "/Users/me/cooler" },
    online: true, last_seen: 20, connected_at: 10, ...fields,
  };
}

describe("mobile machine/workspace aggregation", () => {
  it("renders per-workspace relay registrations as one physical computer card", () => {
    const machines = groupRelayMachines([
      instance(),
      instance({ id: "n-two", device_id: "dev-0123456789abcdef-2222222222222222", name: "work-mac · cooler",
        workspace: "/Users/me/cooler", last_seen: 19 }),
      instance({ id: "n-other", device_id: "dev-fedcba9876543210-3333333333333333", name: "other-pc · app",
        workspace: "/work/app", projects: { app: "/work/app" } }),
    ]);
    expect(machines).toHaveLength(2);
    expect(machines[0]?.machineName).toBe("work-mac");
    expect(machines[0]?.members.map(member => member.id)).toEqual(["n-one", "n-two"]);
    expect(machines[1]?.machineName).toBe("other-pc");
  });

  it("routes every parallel workspace to the member whose root actually owns it", () => {
    const machine = groupRelayMachines([
      instance(),
      instance({ id: "n-two", device_id: "dev-0123456789abcdef-2222222222222222", name: "work-mac · cooler",
        workspace: "/Users/me/cooler", last_seen: 19 }),
    ])[0]!;
    expect(machineWorkspaceRoutes(machine)).toEqual([
      { project: "cooler", path: "/Users/me/cooler", nodeId: "n-two" },
      { project: "luban", path: "/Users/me/luban", nodeId: "n-one" },
    ]);
  });

  it("prefers a live exact owner and deduplicates reported session snapshots", () => {
    const machine = groupRelayMachines([
      instance({ online: false, last_seen: 30, status: { updated_at: 1, jobs: [], sessions: [
        { id: "s", project: "cooler", title: "stale", updated_at: 1 },
      ] } }),
      instance({ id: "n-two", device_id: "dev-0123456789abcdef-2222222222222222", name: "work-mac · cooler",
        workspace: "/Users/me/cooler", online: true, last_seen: 20, status: { updated_at: 2, model: "model-a", jobs: [], sessions: [
          { id: "s", project: "cooler", title: "fresh", updated_at: 2 },
          { id: "other", project: "luban", title: "parallel", updated_at: 3 },
        ] } }),
    ])[0]!;
    expect(machineWorkspaceRoutes(machine).find(route => route.project === "cooler")?.nodeId).toBe("n-two");
    expect(machine.status?.sessions).toHaveLength(2);
    expect(machine.status?.sessions?.find(session => session.id === "s")?.title).toBe("fresh");
  });

  it("keeps unrelated or legacy device identities separate", () => {
    expect(groupRelayMachines([
      instance({ device_id: "legacy-a" }), instance({ id: "n-b", device_id: "legacy-b" }),
    ])).toHaveLength(2);
  });
});
