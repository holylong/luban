import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('../apps/android-native/app/src/main/java/dev/luban/app/MainActivity.java', import.meta.url), 'utf8');
/** @param {string} name */
const method = name => {
  const marker = new RegExp(`private [A-Za-z][\\w<>\\[\\]]* ${name}\\(`).exec(source);
  assert.ok(marker, `method ${name} not found`);
  const start = marker.index;
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
  assert.match(method('pollJob'), /if \(token != pollToken \|\| isDestroyed\(\) \|\| background \|\| !liveRunning\) return/);
});
test('a live job keeps polling until its own status says it finished', () => {
  const poll = method('pollJob');
  // Re-arming inside `finally` keeps the loop alive when an answer is failed or dropped.
  assert.match(poll, /finally \{[\s\S]*?main\.postDelayed\(\(\) -> pollJob\(/);
  // `events.complete` only reports that the replay buffer covered `since`.
  assert.match(poll, /boolean complete = job\.optString\("status"\)\.matches\("done\|failed\|cancelled\|paused"\)/);
  assert.doesNotMatch(poll, /optBoolean\("complete"\)/);
});
test('detail screens have separate back destinations and mode changes preserve drafts', () => {
  assert.match(source, /screen.equals\("job"\)\) \{ showJobs\(\)/);
  assert.match(source, /screen.equals\("transcript"\)/);
  assert.match(method('cycleMode'), /draft.setText\(text\)/);
});

test('one workspace belongs to the computer, so any live instance can serve it', () => {
  for (const name of ['openWorkspace', 'sendDraft', 'loadMachineSessions']) {
    assert.match(method(name), /servingNode\(/, `${name} must route through the machine, not one registration`);
  }
  assert.doesNotMatch(method('openWorkspace'), /nodeId = route\.nodeId/);
  assert.match(method('sendDraft'), /电脑离线/);
});

test('an unreachable session is readable and retryable instead of a dead end', () => {
  assert.match(method('openSession'), /offlineTranscript\(/);
  assert.match(method('offlineTranscript'), /openSession\(id, title, project\)/);
  assert.match(method('openSession'), /machineReachable\(\)/);
});

test('the job list is one queue for the whole computer and can be cancelled', () => {
  assert.match(method('showJobs'), /fetchJobs\(nodeIds\)/);
  assert.match(method('fetchJobs'), /for \(String node : nodeIds\)/);
  assert.match(method('openJob'), /jobOwner\.get\(id\)/);
  assert.match(method('cancelJob'), /client\.cancel\(node, id\)/);
  assert.match(method('pollJob'), /cancelButton/);
});

test('a running session opens its live stream instead of a frozen transcript', () => {
  assert.match(source, /openLiveSession\(id, label, work\)/);
  assert.match(method('openLiveSession'), /queued\|pending\|working/);
  assert.match(method('openLiveSession'), /openJob\(job\)/);
});

test('approvals can be remembered and questions offer their options', () => {
  assert.match(method('renderInteractions'), /"always"/);
  assert.match(method('renderInteractions'), /"tool"/);
  assert.match(method('renderInteractions'), /once_only/);
  assert.match(method('renderInteractions'), /optJSONArray\("options"\)/);
});

test('the model can be switched from settings', () => {
  assert.match(method('showSettings'), /modelCard\(\)/);
  assert.match(method('switchModel'), /client\.setModel\(node, id, effort\)/);
  assert.match(method('chooseModel'), /reasoning_efforts/);
});

test('a cold start fetches the fleet instead of claiming zero computers', () => {
  const devices = method('showDevices');
  // Painted from an unloaded list, the header reads "0 台在线 / 共 0 台电脑" and a
  // manual refresh is the only way back.
  assert.match(devices, /if \(!devicesLoaded\) \{/);
  assert.ok(devices.indexOf('if (!devicesLoaded)') < devices.indexOf('beginPage('));
  assert.match(devices, /loadDevices\(\);\s*return;/);
  assert.match(method('loadDevices'), /devicesLoaded = true;[\s\S]*showDevices\(\)/);
  assert.match(method('showCachedDevices'), /devicesLoaded = true;/);
  // An empty reply must not erase the snapshot used when the relay is unreachable.
  assert.match(method('saveNodesCache'), /if \(nodes\.isEmpty\(\)\) return;/);
});

test('tapping a computer card opens it, not only its bottom button', () => {
  assert.match(method('machineCard'), /card\.setOnClickListener\(v -> openMachine\(machine\.id\)\)/);
});
