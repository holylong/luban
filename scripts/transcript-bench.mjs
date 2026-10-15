/** Build first, then: node scripts/transcript-bench.mjs
 * Measures transcript preparation only, not a full terminal repaint/model call. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildTranscript } from "../dist/ui/transcript-blocks.js";
import { createTranscriptLayout, transcriptLines } from "../dist/ui/transcript-lines.js";

const options = { expanded: true, width: 90 };
const paragraph = "缓存已完成的历史消息，只重新排版当前流式回答。 Measure once and reuse prepared text. ".repeat(8);
for (const count of [100, 500, 2000]) {
  const messages = Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `message-${index}\n${paragraph}\n\`\`\`ts\nconst index = ${index};\n\`\`\``,
  }));
  const history = buildTranscript(messages, options);
  const layout = createTranscriptLayout();
  const run = (reuse) => {
    const times = [];
    let checksum = 0;
    for (let frame = 0; frame < 120; frame++) {
      const tail = [{ id: "streaming", kind: "assistant", text: "正在输出 streaming tail ".repeat(20) + frame, lines: 1 }];
      const start = performance.now();
      const rows = reuse ? layout(history, tail, options.width)
        : transcriptLines([...buildTranscript(messages, options), ...tail], options.width);
      if (frame >= 20) times.push(performance.now() - start);
      checksum += rows.length;
      if (frame === 119 && reuse) assert.deepEqual(rows, transcriptLines([...history, ...tail], options.width));
    }
    times.sort((a, b) => a - b);
    return { p50Ms: times[50], p95Ms: times[95], checksum };
  };
  const before = run(false), after = run(true);
  assert.equal(before.checksum, after.checksum);
  process.stdout.write(JSON.stringify({ messages: count, physicalRows: transcriptLines(history, options.width).length, before, after }) + "\n");
}
