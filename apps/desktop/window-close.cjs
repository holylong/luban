/**
 * Closing a window to the tray, without leaving a black Space behind.
 *
 * macOS keeps a full-screen window in its own Space until it leaves full
 * screen. Calling hide() first hid the content but kept the Space occupied and
 * painted black, so the red button read as "the window went black and is still
 * there". Leaving full screen first releases the Space, then hiding is just a
 * hidden window the tray can bring back.
 */
function hideForTray(win, { fallbackMs = 1200 } = {}) {
  if (!win || win.isDestroyed()) return false;
  if (!win.isFullScreen()) {
    win.hide();
    return true;
  }
  let done = false;
  let timer;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // The leave-full-screen animation may still be running: hide on the next
    // turn of the loop, and never touch a window that died in the meantime.
    setTimeout(() => { if (!win.isDestroyed()) win.hide(); }, 80);
  };
  timer = setTimeout(finish, fallbackMs);
  win.once("leave-full-screen", finish);
  win.setFullScreen(false);
  return true;
}

module.exports = { hideForTray };
