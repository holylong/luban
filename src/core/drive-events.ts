/**
 * The wire format between `luban drive` and whatever drives it (the 造物主
 * window, tests, a future CLI client).
 *
 * These types live in their own module with no imports on purpose: the browser
 * renderer needs them, and importing drive.ts from the renderer would drag the
 * whole agent (and its server-only dependencies) into the client typecheck.
 */

export interface DriveUsage {
  input: number;
  output: number;
  calls: number;
}

export type DriveEvent =
  /** Sent once, before the first turn: what this session can and cannot do. */
  | { type: "ready"; workspace: string; model: string; computer: DriveComputerState }
  | { type: "status"; text: string }
  | { type: "turn-start"; id: string; text: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; id: string; name: string; label: string; args: Record<string, unknown> }
  | { type: "tool-result"; id: string; name: string; ok: boolean; elapsedMs: number; preview: string; screenshot?: string }
  | { type: "approval"; id: string; tool: string; label: string; args: Record<string, unknown>; reason: string }
  | { type: "approval-settled"; id: string; allow: boolean; reason: string }
  | { type: "turn-end"; id: string; ok: boolean; text: string; steps: number; usage: DriveUsage; stopReason?: string }
  | { type: "error"; text: string };

export interface DriveComputerState {
  supported: boolean;
  enabled: boolean;
  accessibility?: boolean;
  postEvent?: boolean;
  screenRecording?: boolean;
  note?: string;
}

export type DriveCommand =
  | { type: "say"; text: string }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "stop" }
  | { type: "status" };
