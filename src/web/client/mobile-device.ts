/** What a device card on the phone has to know about one node. */

export interface RelayJob {
  id: string;
  title: string;
  instruction: string;
  status: string;
  progress: number;
  updated_at: number;
  session_id?: string;
}

/** A session the node's terminal is running right now (not a mesh job). */
export interface RelaySession {
  id: string;
  project: string;
  title: string;
  updated_at: number;
}

export interface RelayDeviceStatus {
  updated_at: number;
  model?: string;
  jobs?: RelayJob[];
  sessions?: RelaySession[];
}

const ACTIVE = new Set(["queued", "pending", "working"]);

export interface DeviceActivity {
  /** Every job the node remembers, newest first. */
  jobs: RelayJob[];
  /** Jobs queued or working. */
  active: RelayJob[];
  /** Terminal sessions running right now. */
  running: RelaySession[];
  /** What the card leads with: live work first, otherwise the last job. */
  latest?: RelayJob;
}

/**
 * One readable answer to "is this laptop busy".
 *
 * A workbench turn is a job and a terminal session is not, so counting only
 * jobs made a busy terminal look idle; both sources are merged here instead.
 */
export function deviceActivity(status: RelayDeviceStatus | undefined): DeviceActivity {
  const jobs = status?.jobs ?? [];
  const active = jobs.filter(job => ACTIVE.has(job.status));
  const running = status?.sessions ?? [];
  return { jobs, active, running, ...(active[0] ?? jobs[0] ? { latest: active[0] ?? jobs[0] } : {}) };
}

/** Chip text for the job or session a card is currently showing. */
export function deviceHeadline(activity: DeviceActivity): string {
  if (activity.running.length > 0) return "正在工作";
  const latest = activity.latest;
  if (!latest) return "";
  return latest.status;
}
