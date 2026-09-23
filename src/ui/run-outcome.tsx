import React from "react";
import { Box, Text } from "ink";
import { theme } from "./theme.js";

export interface RunOutcome {
  status: "completed" | "failed" | "paused" | "cancelled";
  text: string;
  steps?: number;
}

function tailLines(value: string, limit: number): string {
  const lines = value.split("\n");
  if (lines.length <= limit) return value;
  return `${lines.slice(0, 2).join("\n")}\n… ${lines.length - limit} 行已省略 …\n${lines.slice(-(limit - 3)).join("\n")}`;
}

export function RunOutcomeView({ outcome, showText }: { outcome: RunOutcome; showText: boolean }) {
  const presentation = outcome.status === "completed"
    ? { icon: "✓", label: "任务已完成", color: theme.green }
    : outcome.status === "paused"
      ? { icon: "⏸", label: "任务已暂停", color: theme.yellow }
      : outcome.status === "cancelled"
        ? { icon: "⊘", label: "任务已取消", color: theme.muted }
        : { icon: "✗", label: "任务执行失败", color: theme.red };
  return <Box flexDirection="column" borderStyle="round" borderColor={presentation.color} paddingX={1} flexShrink={0}>
    <Text color={presentation.color} bold>{presentation.icon} {presentation.label}{outcome.steps === undefined ? "" : ` · ${outcome.steps} 步`}</Text>
    {showText && outcome.text.trim() ? <Text color={theme.text} wrap="wrap">{tailLines(outcome.text, 8)}</Text> : null}
  </Box>;
}
