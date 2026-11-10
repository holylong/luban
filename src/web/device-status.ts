import type { LubanConfig } from "../core/types.js";
import type { MeshRuntime } from "../core/mesh/runtime.js";
import type { MeshJob } from "../core/mesh/job-store.js";
import { liveSessions } from "../core/live-session.js";

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

/**
 * A session the terminal is running right now.
 *
 * Desktop workbench turns are mesh jobs, so they already travel in `jobs`. A
 * TUI session runs in-process and never becomes a job, which used to leave the
 * phone showing "空闲" for a laptop that was visibly busy.
 */
export interface RelaySessionSummary {
  id: string;
  project: string;
  title: string;
  updated_at: number;
}

export interface RelayDeviceStatus {
  updated_at: number;
  model?: string;
  jobs: RelayJobSummary[];
  sessions: RelaySessionSummary[];
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

/** Runs claimed by the terminal, which the job list cannot show. */
function terminalSessions(config: LubanConfig): RelaySessionSummary[] {
  if (!config.home) return [];
  return liveSessions.runningSummary(config.home)
    // Job-backed runs are mesh jobs: reporting them twice duplicates the card.
    .filter(run => !run.jobId)
    .slice(0, MAX_JOBS)
    .map(run => {
      const seconds = Date.parse(run.updatedAt) / 1000;
      return {
        id: run.id,
        project: run.project,
        title: clip(run.title || run.id),
        updated_at: Number.isFinite(seconds) ? Math.round(seconds) : Math.round(Date.now() / 1000),
      };
    });
}

export async function readDeviceStatus(config: LubanConfig, mesh?: MeshRuntime): Promise<RelayDeviceStatus> {
  const sessions = terminalSessions(config);
  if (!mesh) return { updated_at: Date.now() / 1000, model: config.model.model, jobs: [], sessions };
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
    sessions,
  };
}
