// Keep the page from zooming. iOS Safari ignores "user-scalable=no", so a quick double tap (or a
// pinch) zooms the whole page in — and with the game swallowing touches you can't pinch back out,
// the HUD and hotbar end up off-screen. Block double-tap and pinch zoom ourselves, and if a zoom
// does slip through, snap the page back to 1:1.
const formEl = (t) => !!(t && t.closest && t.closest('input, select, textarea, [contenteditable]'));

export function preventPageZoom() {
  // double tap: cancel the second tap of a quick pair (that's what triggers the zoom)
  let lastEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      if (now - lastEnd < 350 && e.cancelable && !formEl(e.target)) e.preventDefault();
      lastEnd = now;
    },
    { passive: false }
  );
  // pinch (Safari's gesture events) and two-finger zoom
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1 && e.cancelable) e.preventDefault();
    },
    { passive: false }
  );
  // mouse / trackpad double click: no text selection or smart zoom
  document.addEventListener('dblclick', (e) => {
    if (!formEl(e.target)) e.preventDefault();
  });
  // ctrl + wheel / ctrl + plus zoom on desktops (the game uses the wheel for the hotbar)
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey) e.preventDefault();
    },
    { passive: false }
  );

  // a zoom got through anyway: re-apply the viewport so the browser snaps back to 1:1
  const vv = window.visualViewport;
  const meta = document.querySelector('meta[name="viewport"]');
  if (!vv || !meta) return;
  const base = meta.getAttribute('content');
  let busy = false;
  const unzoom = () => {
    if (busy || vv.scale <= 1.02) return;
    busy = true;
    meta.setAttribute('content', base.replace('initial-scale=1', 'initial-scale=1.0001'));
    setTimeout(() => {
      meta.setAttribute('content', base);
      window.scrollTo(0, 0);
      busy = false;
    }, 60);
  };
  vv.addEventListener('resize', unzoom);
  vv.addEventListener('scroll', unzoom);
}
