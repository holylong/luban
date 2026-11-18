import type { RelayDeviceStatus, RelaySession } from "./mobile-device.js";

/** One relay registration: a luban process serving one workspace. */
export interface RelayMachineInstance {
  id: string;
  device_id?: string;
  node_id?: string;
  name: string;
  version: string;
  workspace: string;
  projects: Record<string, string>;
  online: boolean;
  last_seen: number;
  connected_at: number;
  status?: RelayDeviceStatus;
}

/** Several per-workspace registrations which share one stable machine id. */
export interface RelayMachine extends RelayMachineInstance {
  machineId: string;
  machineName: string;
  members: RelayMachineInstance[];
}

/** A project row remains independently routable to the node serving its path. */
export interface MachineWorkspaceRoute {
  project: string;
  path: string;
  nodeId: string;
}

/**
 * instanceDeviceId() appends a 16-hex workspace digest to the persistent
 * `dev-<machine-random>` identity. Keep the per-workspace node id for routing,
 * but use the stable prefix to render one physical-computer card.
 */
export function machineIdForDevice(device: Pick<RelayMachineInstance, "id" | "device_id">): string {
  const id = device.device_id || device.id;
  return /^(dev-[a-f0-9]{16,64})-[a-f0-9]{16}$/iu.exec(id)?.[1] ?? id;
}

function hostLabel(name: string): string {
  const separator = name.lastIndexOf(" · ");
  return separator < 0 ? name : name.slice(0, separator);
}

function machineLabel(members: RelayMachineInstance[]): string {
  const labels = members.map(member => hostLabel(member.name)).filter(Boolean);
  if (!labels.length) return "luban";
  if (labels.length === 1) return labels[0]!;
  let prefix = labels[0]!;
  for (const label of labels.slice(1)) {
    let length = 0;
    while (length < prefix.length && length < label.length && prefix[length] === label[length]) length++;
    prefix = prefix.slice(0, length);
  }
  prefix = prefix.replace(/[\s._-]+$/u, "");
  // Prefer the common machine label (e.g. my-mac for my-mac/my-mac75764);
  // if aliases are unrelated, use the newest registration's label.
  return prefix.length >= 4 ? prefix : labels[0]!;
}

function aggregateStatus(members: RelayMachineInstance[]): RelayDeviceStatus | undefined {
  const liveMembers = members.filter(member => member.online);
  const statuses = (liveMembers.length ? liveMembers : members)
    .map(member => member.status).filter((status): status is RelayDeviceStatus => Boolean(status));
  if (!statuses.length) return undefined;
  const jobs = new Map<string, NonNullable<RelayDeviceStatus["jobs"]>[number]>();
  const sessions = new Map<string, RelaySession>();
  for (const status of statuses) {
    for (const job of status.jobs ?? []) {
      const previous = jobs.get(job.id);
      if (!previous || job.updated_at >= previous.updated_at) jobs.set(job.id, job);
    }
    for (const session of status.sessions ?? []) {
      const key = `${session.project}\0${session.id}`;
      const previous = sessions.get(key);
      if (!previous || session.updated_at >= previous.updated_at) sessions.set(key, session);
    }
  }
  return {
    updated_at: Math.max(...statuses.map(status => status.updated_at || 0)),
    model: new Set(statuses.map(status => status.model).filter((model): model is string => Boolean(model))).size === 1
      ? statuses.find(status => status.model)?.model : undefined,
    jobs: [...jobs.values()].sort((a, b) => b.updated_at - a.updated_at),
    sessions: [...sessions.values()].sort((a, b) => b.updated_at - a.updated_at),
  };
}

/** Group per-workspace registrations without losing their individual route ids. */
export function groupRelayMachines(nodes: RelayMachineInstance[]): RelayMachine[] {
  const groups = new Map<string, RelayMachineInstance[]>();
  for (const node of nodes) {
    const key = machineIdForDevice(node);
    const members = groups.get(key) ?? [];
    members.push(node);
    groups.set(key, members);
  }
  return [...groups].map(([machineId, unsorted]) => {
    // Heartbeats must not reorder instance labels or change the default route.
    const members = [...unsorted].sort((left, right) => left.id.localeCompare(right.id));
    const representative = members.find(member => member.online) ?? members[0]!;
    return {
      ...representative,
      machineId,
      machineName: machineLabel(members),
      members,
      online: members.some(member => member.online),
      workspace: members.length > 1 ? `${members.length} 个工作区` : representative.workspace,
      status: aggregateStatus(members),
    };
  }).sort((left, right) => left.machineId.localeCompare(right.machineId));
}

function normalizedPath(path: string): string {
  const value = path.split(String.fromCharCode(92)).join("/").replace(/\/+$/u, "");
  return /^[A-Za-z]:/u.test(value) ? value.toLowerCase() : value;
}

function folderName(path: string): string {
  return path.split(String.fromCharCode(92)).join("/").replace(/\/+$/u, "").split("/").at(-1) || path;
}

/** Union workspace registrations across per-workspace relay processes. */
export function machineWorkspaceRoutes(machine: RelayMachine): MachineWorkspaceRoute[] {
  const routes = new Map<string, MachineWorkspaceRoute>();
  for (const member of machine.members) {
    for (const [project, path] of Object.entries(member.projects)) {
      if (!path) continue;
      const current = routes.get(project);
      const ownsPath = normalizedPath(path) === normalizedPath(member.workspace);
      const currentOwner = current && machine.members.find(candidate => candidate.id === current.nodeId);
      const currentOwnsPath = Boolean(currentOwner && normalizedPath(current.path) === normalizedPath(currentOwner.workspace));
      if (!current || (ownsPath && !currentOwnsPath) || (member.online && !currentOwner?.online)) {
        routes.set(project, { project, path, nodeId: member.id });
      }
    }
  }
  // Older relays may omit projects even though the registration has a live root.
  for (const member of machine.members) {
    const ownsProject = [...routes.values()].some(route => normalizedPath(route.path) === normalizedPath(member.workspace));
    if (!ownsProject && member.workspace) {
      const project = folderName(member.workspace);
      if (!routes.has(project)) routes.set(project, { project, path: member.workspace, nodeId: member.id });
    }
  }
  return [...routes.values()].sort((left, right) => left.project.localeCompare(right.project));
}
