import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
setTimeout(async () => {
  const { SessionHistory } = await import('../src/core/session-history.ts');
  const directory = join(process.env.LUBAN_HOME, 'history-warning-file');
  writeFileSync(directory, 'This file cannot be used as a database directory.');
  SessionHistory.open({ enabled: true, directory, maxMessagesPerSession: 0 }, process.env.LUBAN_HOME);
}, 6500).unref();
