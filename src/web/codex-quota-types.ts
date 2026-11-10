export interface CodexQuotaWindow {
  id: string;
  label: string;
  remaining: number;
  durationMins?: number;
  resetsAt?: number;
}

export interface CodexResetCredit {
  id: string;
  title: string;
  expiresAt?: number;
}

export interface CodexQuota {
  updatedAt?: number;
  error?: string;
  /** What to do about `error`, when the failure is recognizable. */
  hint?: string;
  /** The CLI's own words, redacted and truncated; shown small for diagnosis. */
  detail?: string;
  windows: CodexQuotaWindow[];
  /** Usable reset cards, in the order Codex returned them. */
  credits?: CodexResetCredit[];
  availableResetCredits?: number;
}
