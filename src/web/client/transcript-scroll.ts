/** Keep layout changes from being mistaken for a user scrolling away. */
export function followTranscript(element: HTMLElement, content: HTMLElement) {
  let pinned = true;
  let lastTop = element.scrollTop;
  const follow = (): void => {
    if (!pinned) return;
    element.scrollTop = element.scrollHeight;
    lastTop = element.scrollTop;
  };
  const onScroll = (): void => {
    const top = element.scrollTop;
    const nearBottom = element.scrollHeight - top - element.clientHeight < 80;
    if (top < lastTop) pinned = nearBottom;
    else if (nearBottom) pinned = true;
    lastTop = top;
  };
  element.addEventListener("scroll", onScroll, { passive: true });
  const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(follow);
  observer?.observe(content);
  observer?.observe(element);
  follow();
  return {
    follow,
    reset: () => { pinned = true; follow(); },
    dispose: () => { observer?.disconnect(); element.removeEventListener("scroll", onScroll); },
  };
}
