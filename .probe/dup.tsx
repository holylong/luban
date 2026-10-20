import React from "react";
import { renderToString } from "ink";
import { Box, Text } from "ink";
import { TextArea } from "../src/ui/text-area.js";

// The user still sees duplicate rows below the box *after* typing. The empty
// branch is fixed; the non-empty branch renders one <Text> per row inside a
// Box that is flexDirection="column" inside a flexDirection="row" parent with
// paddingY={1}. A column Box inside a row Box is what paints the extra blank
// rows: Ink sizes the column to its tallest child but the parent row still
// reserves paddingY on both sides.
const value = "第一行内容\n第二行内容";

for (const [label, v, width] of [
  ["两行内容 width=60", value, 60],
  ["单行内容 width=60", "只有一行", 60],
  ["三行内容 width=60", "a\nb\nc", 60],
  ["单行较短 width=60", "hi", 60],
] as Array<[string, string, number]>) {
  const output = renderToString(
    <Box backgroundColor="blue" paddingX={2} paddingY={1} alignItems="flex-start">
      <Text>Auto</Text>
      <Text> ❯ </Text>
      <TextArea value={v} onChange={() => {}} onSubmit={() => {}} focus placeholder="" width={width} maxRows={12} />
    </Box>,
    { columns: width },
  );
  const lines = output.split("\n");
  console.log(`--- ${label}: 物理行数=${lines.length} ---`);
  for (const [i, line] of lines.entries()) console.log(`  ${i}: ${JSON.stringify(line)}`);
}

// And the whole frame, to see what the paddingY rows look like.
console.log("\n=== 完整帧（含 paddingY 上下各 1 行）===");
const frame = renderToString(
  <Box flexDirection="column" backgroundColor="blue">
    <Box backgroundColor="blue" paddingX={2} paddingY={1} alignItems="flex-start">
      <Text>Auto</Text>
      <Text> ❯ </Text>
      <TextArea value="hi" onChange={() => {}} onSubmit={() => {}} focus placeholder="" width={60} maxRows={12} />
    </Box>
  </Box>,
  { columns: 60 },
);
for (const [i, line] of frame.split("\n").entries()) console.log(`  ${i}: ${JSON.stringify(line)}`);