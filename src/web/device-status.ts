import type { LubanConfig } from "../core/types.js";
import type { MeshRuntime } from "../core/mesh/runtime.js";
import type { MeshJob } from "../core/mesh/job-store.js";

/**
 * Compact status the node pushes with every relay poll.
 *
 * The phone needs "what is this laptop doing" without opening six separate
 * tunnel requests. Job payloads can contain megabytes of logs, so only the
 * fields needed by the device list travel: identity, state, progress and a
 * bounded instruction/title.
 */
export interface RelayJobSummary {
  id: string;
  title: string;
  instruction: string;
  status: MeshJob["status"];
  progress: number;
  updated_at: number;
  session_id?: string;
}

export interface RelayDeviceStatus {
  updated_at: number;
  model?: string;
  jobs: RelayJobSummary[];
}

const MAX_JOBS = 8;
const MAX_TEXT = 240;

function clip(value: string): string {
  const text = value.replaceAll(/\s+/gu, " ").trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function summarizeJob(job: MeshJob): RelayJobSummary {
  return {
    id: job.id,
    title: clip(job.title || job.instruction || job.id),
    instruction: clip(job.instruction),
    status: job.status,
    progress: job.progress || 0,
    updated_at: job.updated_at,
    ...(job.session_id ? { session_id: job.session_id } : {}),
  };
}

export async function readDeviceStatus(config: LubanConfig, mesh?: MeshRuntime): Promise<RelayDeviceStatus> {
  if (!mesh) return { updated_at: Date.now() / 1000, model: config.model.model, jobs: [] };
  // Instances share one job directory, so an unfiltered list shows every card on
  // the phone the same recent task: ten devices then look like ten copies of one
  // instruction. A device reports the work addressed to it (or claimed by it).
  const node = mesh.config.mesh.nodeName;
  const instance = mesh.instance;
  const jobs = (await mesh.jobs(MAX_JOBS * 8))
    .filter(job => job.target === node || job.instance_id === instance)
    .slice(0, MAX_JOBS);
  return {
    updated_at: Date.now() / 1000,
    model: config.model.model,
    jobs: jobs.map(summarizeJob),
  };
}
