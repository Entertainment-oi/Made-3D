import { isCssLandscape90 } from '../../src/core/viewportCoords.js';

export function computeRangeRatio(rect, e, { isVertical = false, isRot90 = false } = {}) {
  if (!rect) return 0;
  const cx = Number(e?.clientX ?? 0);
  const cy = Number(e?.clientY ?? 0);
  if (isVertical && !isRot90) {
    const len = rect.height || 1;
    const pad = Math.min(7, len * 0.14);
    const usable = Math.max(1, len - pad * 2);
    return Math.max(0, Math.min(1, (rect.bottom - pad - cy) / usable));
  }
  if (isVertical && isRot90) {
    const len = rect.width || 1;
    const pad = Math.min(7, len * 0.14);
    const usable = Math.max(1, len - pad * 2);
    return Math.max(0, Math.min(1, (cx - (rect.left + pad)) / usable));
  }
  if (isRot90) {
    const len = rect.height || 1;
    const pad = Math.min(7, len * 0.14);
    const usable = Math.max(1, len - pad * 2);
    return Math.max(0, Math.min(1, (cy - (rect.top + pad)) / usable));
  }
  const len = rect.width || 1;
  const pad = Math.min(7, len * 0.14);
  const usable = Math.max(1, len - pad * 2);
  return Math.max(0, Math.min(1, (cx - (rect.left + pad)) / usable));
}

export function ratioToInputValue(input, t) {
  const min = Number(input?.min === '' || input?.min == null ? 0 : input.min);
  const max = Number(input?.max === '' || input?.max == null ? 100 : input.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return Number(input?.value ?? 0);
  }
  const clampedT = Math.max(0, Math.min(1, Number(t) || 0));
  const raw = min + clampedT * (max - min);
  const stepRaw = input?.step;
  let snapped = raw;
  if (stepRaw && stepRaw !== 'any') {
    const step = Number(stepRaw);
    if (Number.isFinite(step) && step > 0) {
      const steps = Math.round((raw - min) / step);
      snapped = min + steps * step;
      const dec = (String(stepRaw).split('.')[1] || '').length;
      if (dec > 0) snapped = Number(snapped.toFixed(dec));
    }
  }
  return Math.max(min, Math.min(max, snapped));
}

export function syncRangeVisual(input) {
  if (!input || !input.style) return;
  const min = Number(input.min === '' || input.min == null ? 0 : input.min);
  const max = Number(input.max === '' || input.max == null ? 100 : input.max);
  const val = Number(input.value ?? min);
  const pct =
    Number.isFinite(min) && Number.isFinite(max) && max > min && Number.isFinite(val)
      ? Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100))
      : 0;
  input.style.setProperty('--range-pct', `${pct.toFixed(2)}%`);
}

export function syncAllRanges(root = typeof document !== 'undefined' ? document : null) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  root.querySelectorAll('input[type="range"]').forEach((el) => syncRangeVisual(el));
}

let _bound = false;

export function bindRangeControls() {
  if (_bound || typeof document === 'undefined' || typeof window === 'undefined') return;
  _bound = true;

  syncAllRanges(document);

  const onValueEvent = (e) => {
    const target = e.target;
    if (target && target.tagName === 'INPUT' && target.type === 'range') {
      syncRangeVisual(target);
    }
  };
  document.addEventListener('input', onValueEvent, true);
  document.addEventListener('change', onValueEvent, true);

  let activeDrag = null;

  const updateFromEvent = (input, e) => {
    const rect = input.getBoundingClientRect();
    const isVertical = input.classList.contains('v-range');
    const isRot90 = isCssLandscape90();
    const ratio = computeRangeRatio(rect, e, { isVertical, isRot90 });
    const nextVal = ratioToInputValue(input, ratio);
    const nextStr = String(nextVal);
    if (input.value !== nextStr) {
      input.value = nextStr;
      syncRangeVisual(input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
      const target = e.target;
      if (!target || target.tagName !== 'INPUT' || target.type !== 'range' || target.disabled) return;
      const isVertical = target.classList.contains('v-range');
      if (!isVertical && !isCssLandscape90()) return;

      e.preventDefault();
      try {
        target.focus({ preventScroll: true });
      } catch (_) {}
      try {
        target.setPointerCapture(e.pointerId);
      } catch (_) {}

      activeDrag = {
        input: target,
        pointerId: e.pointerId,
        startValue: target.value,
      };
      updateFromEvent(target, e);
    },
    true
  );

  const onMove = (e) => {
    if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
    if (!activeDrag.input.isConnected || activeDrag.input.disabled) {
      activeDrag = null;
      return;
    }
    e.preventDefault();
    updateFromEvent(activeDrag.input, e);
  };

  const onEnd = (e) => {
    if (!activeDrag || e.pointerId !== activeDrag.pointerId) return;
    const { input, pointerId, startValue } = activeDrag;
    activeDrag = null;
    try {
      if (input.hasPointerCapture?.(pointerId)) {
        input.releasePointerCapture(pointerId);
      }
    } catch (_) {}
    if (input.value !== startValue) {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onEnd);
  window.addEventListener('pointercancel', onEnd);
}
