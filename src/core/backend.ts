export interface BackendJob {
  id: string;
  status: "queued" | "pending" | "working" | "handed_off" | "done" | "failed" | "cancelled";
  instruction: string;
  project_id: string;
  result?: string;
  error?: string;
  logs?: Array<{ t: number; level: string; msg: string }>;
}

export interface BackendPeer {
  name: string;
  host: string;
  port: number;
  last_seen?: number;
  capabilities?: string[];
}

export class LubanBackend {
  constructor(readonly baseUrl: string) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.baseUrl) throw new Error("LUBAN_BACKEND_URL is not configured");
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(20_000),
    });
    const payload = await response.json() as { ok?: boolean; error?: string } & T;
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `backend HTTP ${response.status}`);
    return payload;
  }

  node(): Promise<Record<string, unknown>> {
    return this.request("/api/node");
  }

  peers(): Promise<BackendPeer[]> {
    return this.request("/api/peers");
  }

  jobs(): Promise<BackendJob[]> {
    return this.request("/api/jobs");
  }

  job(id: string): Promise<BackendJob> {
    return this.request(`/api/jobs/${encodeURIComponent(id)}`);
  }

  async submit(instruction: string, projectId = ""): Promise<string> {
    const result = await this.request<{ job_id: string }>("/api/jobs", {
      method: "POST",
      body: JSON.stringify({ instruction, project_id: projectId }),
    });
    return result.job_id;
  }

  async cancel(id: string): Promise<void> {
    await this.request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
  }

  async wait(id: string, signal: AbortSignal, onUpdate?: (job: BackendJob) => void): Promise<BackendJob> {
    while (!signal.aborted) {
      const job = await this.job(id);
      onUpdate?.(job);
      if (["done", "failed", "cancelled"].includes(job.status)) return job;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 1_000);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw signal.reason ?? new Error("aborted");
  }
}
