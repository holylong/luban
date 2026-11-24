import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { HEALTH_PROBE, createRendererWatch } from './renderer-health.cjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
test('probe rejects empty, partial and invisible workbenches', () => {
  const run = (app, style = {}) => vm.runInNewContext(HEALTH_PROBE, {
    document: { querySelector: () => app },
    getComputedStyle: () => ({ display: 'grid', visibility: 'visible', opacity: '1', ...style }),
  });
  assert.equal(run(null), false);
  assert.equal(run({ querySelector: () => null }), false);
  const app = { querySelector: () => ({}), getBoundingClientRect: () => ({ width: 1500, height: 950 }) };
  assert.equal(run(app), true);
  for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }]) assert.equal(run(app, style), false);
});
test('two blank responses recover exactly once', async () => {
  const reasons = [];
  const watch = createRendererWatch({ probe: () => false, recover: reason => reasons.push(reason) });
  watch.tick(); await flush(); assert.equal(reasons.length, 0);
  watch.tick(); await flush(); watch.tick(); await flush();
  assert.deepEqual(reasons, ['workbench DOM is missing or invisible']);
});
test('healthy answers reset transient failures and rejected probes count as failures', async () => {
  let healthy = false;
  let recovered = 0;
  const watch = createRendererWatch({ probe: () => {
    if (healthy === null) throw Error('context gone');
    return healthy;
  }, recover: () => recovered++ });
  watch.tick(); await flush();
  healthy = true; watch.tick(); await flush();
  healthy = null; watch.tick(); await flush(); assert.equal(recovered, 0);
  watch.tick(); await flush(); assert.equal(recovered, 1);
});
test('unanswered probes time out even when the clock starts at zero', async () => {
  let time = 0;
  let recovered = 0;
  const watch = createRendererWatch({ probe: () => new Promise(() => {}), now: () => time, recover: () => recovered++ });
  watch.tick(); await flush(); time = 14999; watch.tick(); assert.equal(recovered, 0);
  time = 15000; watch.tick(); watch.tick(); assert.equal(recovered, 1);
});
test('stopped watches ignore late answers from destroyed windows', async () => {
  let answer;
  const watch = createRendererWatch({ probe: () => new Promise(resolve => { answer = resolve; }), recover: () => assert.fail('stale recovery') });
  watch.tick(); await flush(); watch.stop(); answer(false); await flush(); watch.tick();
});
