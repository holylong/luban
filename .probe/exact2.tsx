import React from "react";
import { renderToString } from "ink";
import { Box, Text } from "ink";
import { TextArea } from "../src/ui/text-area.js";
import { Spinner } from "../src/ui/thinking-line.js";
import { displayWidth } from "../src/ui/input-layout.js";

// Use the real Spinner so the indent matches app.tsx exactly: running draws a
// 1-column spinner, idle draws a 4-column "Auto" label.
const running = "补充指令 · /queue 排队 · Esc 中断";
const idle = "Message luban… · Ctrl+J 换行 · @ 文件";

function render(columns: number, isRunning: boolean, placeholder: string): string[] {
  const indent = (isRunning ? 1 : "Auto".length) + 3;
  const inputWidth = Math.max(1, columns - 4 - indent - 1);
  return renderToString(
    <Box backgroundColor="#33202f" paddingX={2} paddingY={1} alignItems="flex-start">
      {isRunning ? <Spinner /> : <Text color="#ff8fc4" bold>Auto</Text>}
      <Text color="#ff8fc4"> ❯ </Text>
      <TextArea value="" onChange={() => {}} onSubmit={() => {}} focus placeholder={placeholder} width={inputWidth} maxRows={12} />
    </Box>,
    { columns },
  ).split("\n");
}

console.log("=== 用真实 Spinner 精确验证 ===");
for (const [label, isRunning, placeholder] of [["idle", false, idle], ["running", true, running]] as Array<[string, boolean, string]>) {
  for (const columns of [120, 100, 80, 72, 60, 50, 40]) {
    const lines = render(columns, isRunning, placeholder);
    const textLines = lines.filter((line) => line.trim());
    const overflow = lines.filter((line) => displayWidth(line) > columns);
    const ok = textLines.length === 1 && overflow.length === 0;
    console.log(`  ${label.padEnd(8)} columns=${String(columns).padStart(3)} 行数=${textLines.length} ${ok ? "✓" : "✗ " + JSON.stringify(textLines)}`);
    if (!ok) for (const [i, l] of lines.entries()) console.log(`       ${i}: ${JSON.stringify(l)} (w=${displayWidth(l)})`);
  }
}