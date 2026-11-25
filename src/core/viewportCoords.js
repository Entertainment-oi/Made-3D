export function isCssLandscape90(doc = typeof document !== 'undefined' ? document : null) {
  return Boolean(doc?.documentElement?.classList?.contains('is-mobile-landscape-90'));
}

export function getLogicalViewportSize(
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  const iw = Number(win?.innerWidth || 0);
  const ih = Number(win?.innerHeight || 0);
  if (isCssLandscape90(doc)) {
    return { width: ih, height: iw };
  }
  return { width: iw, height: ih };
}

export function clientToViewportPoint(
  e,
  win = typeof window !== 'undefined' ? window : null,
  doc = typeof document !== 'undefined' ? document : null
) {
  const cx = Number(e?.clientX ?? 0);
  const cy = Number(e?.clientY ?? 0);
  if (isCssLandscape90(doc)) {
    return { x: cy, y: Number(win?.innerWidth || 0) - cx };
  }
  return { x: cx, y: cy };
}

export function clientToLocalPointFromRect(
  rect,
  e,
  targetWidth = null,
  targetHeight = null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!rect) return [Number(e?.clientX ?? 0), Number(e?.clientY ?? 0)];
  const cx = Number(e?.clientX ?? 0);
  const cy = Number(e?.clientY ?? 0);
  if (isCssLandscape90(doc)) {
    const w = targetWidth ?? (rect.height || 1);
    const h = targetHeight ?? (rect.width || 1);
    return [
      ((cy - rect.top) / (rect.height || 1)) * w,
      ((rect.right - cx) / (rect.width || 1)) * h,
    ];
  }
  const w = targetWidth ?? (rect.width || 1);
  const h = targetHeight ?? (rect.height || 1);
  return [
    ((cx - rect.left) / (rect.width || 1)) * w,
    ((cy - rect.top) / (rect.height || 1)) * h,
  ];
}

export function clientToLocalPoint(
  el,
  e,
  targetWidth = null,
  targetHeight = null,
  doc = typeof document !== 'undefined' ? document : null
) {
  if (!el || typeof el.getBoundingClientRect !== 'function') {
    return [Number(e?.clientX ?? 0), Number(e?.clientY ?? 0)];
  }
  const rect = el.getBoundingClientRect();
  const w = targetWidth ?? (el.clientWidth || (isCssLandscape90(doc) ? rect.height : rect.width) || 1);
  const h = targetHeight ?? (el.clientHeight || (isCssLandscape90(doc) ? rect.width : rect.height) || 1);
  return clientToLocalPointFromRect(rect, e, w, h, doc);
}

export function isMobilePhoneDevice(env = {}) {
  const nav = env.navigator !== undefined ? env.navigator : (typeof navigator !== 'undefined' ? navigator : null);
  const win = env.window !== undefined ? env.window : (typeof window !== 'undefined' ? window : null);
  if (!nav || !win) return false;

  if (nav.userAgentData && typeof nav.userAgentData.mobile === 'boolean') {
    if (nav.userAgentData.mobile) return true;
  }

  const ua = String(nav.userAgent || '');
  const isPhoneUA =
    /iphone|ipod|windows phone|iemobile|blackberry|bb10|opera mini|mobile.*firefox/i.test(ua) ||
    (/android/i.test(ua) && /mobile/i.test(ua));
  if (isPhoneUA) return true;

  const isTabletUA = /ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua));
  if (isTabletUA) return false;

  const coarse = typeof win.matchMedia === 'function' ? Boolean(win.matchMedia('(pointer: coarse)')?.matches) : false;
  const touchPoints = Number(nav.maxTouchPoints || 0);
  const sw = Number(win.screen?.width || win.innerWidth || 0);
  const sh = Number(win.screen?.height || win.innerHeight || 0);
  const shortSide = Math.min(sw || Infinity, sh || Infinity);
  return Boolean(coarse && touchPoints > 0 && shortSide <= 600);
}
