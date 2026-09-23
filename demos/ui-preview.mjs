// Offline preview of the same components used by the TUI. No model calls.
import React from "react";
import { Box, Text, renderToString } from "ink";
import { ExecutionTimeline } from "../dist/ui/execution-view.js";
import { theme } from "../dist/ui/theme.js";
const entries = [
  { name: "read_file", detail: "src/profile.ts", status: "done", elapsedMs: 18, preview: "Read 48 lines" },
  { name: "edit_file", detail: "src/profile.ts", status: "done", elapsedMs: 32,
    editPreview: 'Edited src/profile.ts (+2 -1)\n    12  export async function loadProfile(userId: string): Promise<User> {\n    13 -  const result = await fetch("/api/user");\n    13 +  const result = await fetchProfile(userId, 42);\n    14 +  return result ?? null; // Missing profiles are allowed\n    15  }' },
  { name: "bash", detail: "npm run typecheck", status: "done", elapsedMs: 1420, preview: "TypeScript check passed" },
  { name: "bash", detail: "npm test", status: "failed", elapsedMs: 850, preview: "FAIL profile.test.ts\nExpected status 200, received 404" },
  { name: "grep_files", detail: "pattern=loadProfile · path=src", status: "running" },
];
console.log(renderToString(React.createElement(Box, { flexDirection: "column", backgroundColor: theme.background, padding: 1 },
  React.createElement(Text, { color: theme.accent, bold: true }, "luban · execution preview"),
  React.createElement(ExecutionTimeline, { entries, expanded: true, pageSize: 32 }),
), { columns: Math.min(process.stdout.columns || 100, 110) }));
if (process.env.LUBAN_PREVIEW_HOLD === "1") process.stdin.resume();
