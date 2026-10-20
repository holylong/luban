import React from "react";
import { renderToString } from "ink";
import { Box, Text } from "ink";
import { TextArea } from "../src/ui/text-area.js";

// The empty branch now pins `width={width}`, but `width` is the column budget
// app.tsx computed for the *text*, while the box also has to live beside the
// mode label and the " ❯ " prompt inside a row that already spent paddingX.
// Ink then squeezes the fixed-width box and wraps whatever does not fit,
// pushing "to" or "o" onto a second row.

const element = "#33202f";
const panel = "#241722";

// Same arithmetic as app.tsx, but sweeping terminal width against a fixed
// text-area width to find where the squeeze starts.
for (const columns of [120, 100, 80, 70, 60, 52, 50, 40]) {
  const indent = 4 + 3; // (running ? 1 : "Auto".length) + 3
  const inputWidth = Math.max(1, columns - 4 - indent - 1);
  const output = renderToString(
    <Box backgroundColor={element} paddingX={2} paddingY={1} alignItems="flex-start">
      <Text color="#ff8fc4" bold>Auto</Text>
      <Text color="#ff8fc4"> ❯ </Text>
      <TextArea value="" onChange={() => {}} onSubmit={() => {}} focus placeholder="Message luban…" width={inputWidth} maxRows={12} />
    </Box>,
    { columns },
  );
  const lines = output.split("\n");
  const bad = lines.filter((line) => line.trim() && !line.includes("Auto ❯ Message luban"));
  console.log(`columns=${String(columns).padStart(3)} inputWidth=${String(inputWidth).padStart(3)} rows=${lines.length} ${bad.length ? "  ✗ 溢出: " + JSON.stringify(bad) : "✓"}`);
  if (lines.length > 3) {
    for (const [i, line] of lines.entries()) console.log(`     ${i}: ${JSON.stringify(line)}`);
  }
}