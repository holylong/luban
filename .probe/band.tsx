import React from "react";
import { renderToString } from "ink";
import { Box, Text } from "ink";
import { TextArea } from "../src/ui/text-area.js";

// Reproduce the exact bottom stack from app.tsx lines 2593+:
//   <Box flexDirection="column" backgroundColor={theme.panel} flexShrink={0}>
//     <Box backgroundColor={theme.element} paddingX={2} paddingY={1}> ... TextArea ... </Box>
//     <Box justifyContent="space-between" paddingX={2} height={1}> status bar </Box>
//   </Box>
// The purple band sits *below* the status bar, so it is whatever follows the
// panel — the notice row, or the app root background.
const element = "#33202f";
const panel = "#241722";

function stack(extra: React.ReactNode, label: string): void {
  const output = renderToString(
    <Box flexDirection="column" backgroundColor="#0a0a0a" height={20}>
      <Box flexDirection="column" backgroundColor={panel} flexShrink={0}>
        <Box backgroundColor={element} paddingX={2} paddingY={1} alignItems="flex-start">
          <Text color="#ff8fc4" bold>Auto</Text>
          <Text color="#ff8fc4"> ❯ </Text>
          <TextArea value="" onChange={() => {}} onSubmit={() => {}} focus placeholder="Message luban…" width={52} maxRows={12} />
        </Box>
        <Box justifyContent="space-between" paddingX={2} height={1} overflow="hidden">
          <Text color="#888">Kimi K3  0↑ 0↓ · ctx 1%</Text>
        </Box>
      </Box>
      {extra}
    </Box>,
    { columns: 60 },
  );
  const lines = output.split("\n");
  console.log(`--- ${label}: ${lines.length} 行 ---`);
  for (const [i, line] of lines.entries()) console.log(`  ${String(i).padStart(2)}: ${JSON.stringify(line)}`);
}

// With the notice row present (the default hint is suppressed, so an empty
// frame shows nothing) versus a real notice.
stack(<Box paddingX={2} height={1}><Text>▸ notice here</Text></Box>, "有 notice 行");
stack(null, "无 notice 行");
stack(<Box paddingX={2} height={1}><Text>▸ 未知指令 /statuss · 你想用 /status 吗？</Text></Box>, "notice 行较长");