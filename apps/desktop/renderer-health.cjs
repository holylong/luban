// A live JavaScript context is not proof React still paints the workbench.
const HEALTH_PROBE = `(() => {
  const app = document.querySelector('#root .desktop-app');
  if (!app || !app.querySelector('.desktop-status')) return false;
  const rect = app.getBoundingClientRect();
  const style = getComputedStyle(app);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
    style.visibility !== 'hidden' && Number(style.opacity) !== 0;
})()`;

function createRendererWatch({ probe, recover, now = Date.now, timeoutMs = 15000 }) {
  let pending;
  let failures = 0;
  let stopped = false;
  function fail(detail) {
    // Allow one transient render failure, not a permanently empty workbench.
    if (++failures < 2) return;
    stopped = true;
    recover(detail);
  }
  return {
    tick() {
      if (stopped) return;
      if (pending) {
        if (now() - pending.at >= timeoutMs) {
          stopped = true;
          recover('renderer health probe timed out');
        }
        return;
      }
      const request = { at: now() };
      pending = request;
      Promise.resolve().then(probe).then(healthy => {
        if (stopped || pending !== request) return;
        pending = undefined;
        if (healthy === true) failures = 0;
        else fail('workbench DOM is missing or invisible');
      }, () => {
        if (stopped || pending !== request) return;
        pending = undefined;
        fail('renderer health probe rejected');
      });
    },
    stop() { stopped = true; },
  };
}
module.exports = { HEALTH_PROBE, createRendererWatch };
