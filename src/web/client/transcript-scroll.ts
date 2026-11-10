/** Keep layout changes from being mistaken for a user scrolling away.
 *
 *  A transcript pins to the newest line until the reader scrolls up; anything
 *  that only changes how tall the content is (a session loading, a tool card
 *  opening, the viewport resizing) must not look like "the reader left the
 *  tail", or the page silently stops following for the rest of the task.
 */
export function followTranscript(element: HTMLElement, content: HTMLElement) {
  const tailSlack = 80;
  let pinned = true;
  let lastTop = element.scrollTop;
  let lastHeight = element.scrollHeight;
  const atTail = (): boolean =>
    element.scrollHeight - element.scrollTop - element.clientHeight < tailSlack;
  const follow = (): void => {
    if (!pinned) return;
    element.scrollTop = element.scrollHeight;
    lastTop = element.scrollTop;
    lastHeight = element.scrollHeight;
  };
  const onScroll = (): void => {
    const top = element.scrollTop;
    const height = element.scrollHeight;
    const resized = height !== lastHeight;
    lastHeight = height;
    if (atTail()) pinned = true;
    else if (!resized && top < lastTop) pinned = false;
    lastTop = top;
  };
  element.addEventListener("scroll", onScroll, { passive: true });
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(follow);
  observer?.observe(content);
  observer?.observe(element);
  follow();
  /** Jump to the newest line and resume following it. */
  const pin = (): void => { pinned = true; follow(); };
  return {
    follow,
    pin,
    reset: pin,
    isPinned: () => pinned,
    dispose: () => { observer?.disconnect(); element.removeEventListener("scroll", onScroll); },
  };
}
