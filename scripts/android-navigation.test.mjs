import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../apps/android-native/app/src/main/java/dev/luban/app/MainActivity.java', import.meta.url), 'utf8');
/** @param {string} name */
const method = name => {
  const start = source.indexOf(`private void ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf('\n    private ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
};
test('jobs retain history and recover without submitting replacements', () => {
  assert.match(method('openJob'), /appendHistory/);
  assert.match(method('openJob'), /baseline/);
  assert.match(method('resumeJob'), /client.resume\(node, id\)/);
  assert.doesNotMatch(method('resumeJob'), /\.submit\(/);
  assert.match(method('sendDraft'), /mutations.execute/);
  assert.match(method('sendDraft'), /submission_pending/);
  assert.match(method('sendDraft'), /instruction:/);
  assert.match(method('restoreActive'), /openJob\(jobId\)/);
  assert.doesNotMatch(source, /io.shutdownNow\(/);
});
test('prompts are rendered and background polling is client-only', () => {
  assert.match(method('renderInteractions'), /client.decide/);
  assert.match(method('renderInteractions'), /client.answer/);
  assert.match(source, /onStop\(\)[\s\S]*?background = true/);
  assert.doesNotMatch(source.slice(source.indexOf('onStop()'), source.indexOf('private void saveActive')), /\.cancel\(/);
});
test('foreground recovery reloads history and reports offline without cancelling work', () => {
  const resume = source.slice(source.indexOf('onResume()'), source.indexOf('private void observeSubmission'));
  assert.match(resume, /openJob\(jobId\)/);
  assert.ok(resume.indexOf('background = false') < resume.indexOf('observeSubmission()'));
  assert.match(method('pollJob'), /电脑端任务不会因此取消/);
});
test('navigation is restored and never hidden by sessions', () => {
  assert.match(method('buildNav'), /setVisibility\(View.VISIBLE\)/);
  assert.doesNotMatch(source, /navBar.setVisibility\(View.GONE\)/);
});
test('async results are guarded against page changes and destruction', () => {
  assert.match(method('postResult'), /generation == pageGeneration/);
  assert.match(method('postResult'), /!isDestroyed\(\)/);
  assert.equal((source.match(/io.execute\(/g) || []).length, 1);
  assert.equal((source.match(/main.post\(/g) || []).length, 1);
  for (const name of ['showDevices', 'showJobs', 'showSettings', 'loadSessions', 'openSession', 'openJob']) {
    assert.match(method(name), /beginPage\(/);
  }
});
test('polling stops before submitting another obsolete request', () => {
  assert.match(method('pollJob'), /if \(token != pollToken \|\| isDestroyed\(\) \|\| background\) return/);
});
test('detail screens have separate back destinations and mode changes preserve drafts', () => {
  assert.match(source, /screen.equals\("job"\)\) \{ showJobs\(\)/);
  assert.match(source, /screen.equals\("transcript"\)/);
  assert.match(method('cycleMode'), /draft.setText\(text\)/);
});
