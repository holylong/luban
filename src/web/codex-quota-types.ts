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
  windows: CodexQuotaWindow[];
  /** Usable reset cards, in the order Codex returned them. */
  credits?: CodexResetCredit[];
  availableResetCredits?: number;
}
