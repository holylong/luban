import React from "react";
import { renderToString } from "ink";
import { Box, Text } from "ink";
import { TextArea } from "../src/ui/text-area.js";
import { displayWidth } from "../src/ui/input-layout.js";

// Exact check: render the composer at a given terminal width and assert the
// drawn line never exceeds the terminal and never spills onto extra rows.
function render(columns: number, indent: number, placeholder: string, width?: number): string[] {
  const inputWidth = width ?? Math.max(1, columns - 4 - indent - 1);
  return renderToString(
    <Box backgroundColor="#33202f" paddingX={2} paddingY={1} alignItems="flex-start">
      <Text color="#ff8fc4" bold>{indent === 4 ? "Auto" : "R"}</Text>
      <Text color="#ff8fc4"> ❯ </Text>
      <TextArea value="" onChange={() => {}} onSubmit={() => {}} focus placeholder={placeholder} width={inputWidth} maxRows={12} />
    </Box>,
    { columns },
  ).split("\n");
}

const running = "补充指令 · /queue 排队 · Esc 中断";
const idle = "Message luban… · Ctrl+J 换行 · @ 文件";

console.log("=== 精确检查：每行显示宽度 ≤ 终端列数，且内容行数 = 1 ===");
for (const [label, indent, placeholder] of [["idle", 7, idle], ["running", 4, running]] as Array<[string, number, string]>) {
  for (const columns of [120, 100, 80, 72, 60, 50, 40]) {
    const lines = render(columns, indent, placeholder);
    const textLines = lines.filter((line) => line.trim());
    const overflow = lines.filter((line) => displayWidth(line) > columns);
    const ok = textLines.length === 1 && overflow.length === 0;
    console.log(`  ${label.padEnd(8)} columns=${String(columns).padStart(3)}  行数=${textLines.length} ${ok ? "✓" : "✗ " + JSON.stringify(textLines)}`);
  }
}