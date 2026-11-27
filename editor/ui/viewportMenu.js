import { clientToLocalPoint } from '../../src/core/viewportCoords.js';
import { dom, setStatus } from '../dom.js';
import { viewport, sceneStore, lighting, sculpt, edit, rig, paint } from '../store.js';
import { resetCamera, syncShadowResolutionUI } from '../viewport.js';
import { setNeutralLightingMode, applyEnvironmentPreset } from '../sceneActions.js';
import { closeAllPopovers } from './popovers.js';

const LONG_PRESS_MS = 450;

export function syncViewportContextMenu() {
  const neutralOn = Boolean(lighting.neutralMode);
  const shadowsOn = !neutralOn && Boolean(lighting.dirLight?.castShadow);
  const envOn = !neutralOn && Boolean(viewport.scene?.environment);
  const floorOn = Boolean(sceneStore.floor?.visible);
  const gridOn = Boolean(sceneStore.grid?.visible);

  const syncToggleBtn = (btn, badge, active, activeText = 'On', offText = 'Off') => {
    if (!btn) return;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-checked', active ? 'true' : 'false');
    if (badge) badge.textContent = active ? activeText : offText;
  };

  syncToggleBtn(dom.btnCtxNeutral, dom.ctxNeutralBadge, neutralOn, 'Activo', 'Off');
  syncToggleBtn(dom.btnCtxShadows, dom.ctxShadowsBadge, shadowsOn);
  syncToggleBtn(dom.btnCtxEnv, dom.ctxEnvBadge, envOn);
  syncToggleBtn(dom.btnCtxFloor, dom.ctxFloorBadge, floorOn);
  syncToggleBtn(dom.btnCtxGrid, dom.ctxGridBadge, gridOn);
}

export function closeViewportContextMenu() {
  if (dom.viewportContextMenu) {
    dom.viewportContextMenu.hidden = true;
  }
}

export function openViewportContextMenu(clientX, clientY) {
  const menu = dom.viewportContextMenu;
  const wrap = dom.viewportWrap;
  if (!menu || !wrap) return;

  closeAllPopovers();
  syncViewportContextMenu();

  menu.hidden = false;
  const wrapW = wrap.clientWidth || 320;
  const wrapH = wrap.clientHeight || 240;
  const [lx, ly] = clientToLocalPoint(wrap, { clientX, clientY }, wrapW, wrapH);

  const menuW = menu.offsetWidth || 228;
  const menuH = menu.offsetHeight || 240;
  const pad = 10;
  const maxX = Math.max(pad, wrapW - menuW - pad);
  const maxY = Math.max(pad, wrapH - menuH - pad);

  const left = Math.min(Math.max(pad, Math.round(lx - menuW * 0.5)), maxX);
  const preferAbove = ly > menuH + 24;
  const rawTop = preferAbove ? ly - menuH - 12 : ly + 12;
  const top = Math.min(Math.max(pad, Math.round(rawTop)), maxY);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function bindViewportContextMenu() {
  const wrap = dom.viewportWrap;
  const menu = dom.viewportContextMenu;
  if (!wrap || !menu) return;

  const activePointers = new Set();
  let press = null;
  let pressTimer = 0;
  let suppressContextUntil = 0;

  const clearPress = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = 0;
    }
    press = null;
  };

  const isViewportCanvas = (target) =>
    target instanceof HTMLCanvasElement && wrap.contains(target);

  wrap.addEventListener('pointerdown', (e) => {
    const pid = e.pointerId ?? 1;
    activePointers.add(pid);

    if (e.target.closest('#viewport-context-menu')) {
      clearPress();
      return;
    }

    if (activePointers.size > 1 || (e.pointerType === 'mouse' && e.button !== 0)) {
      clearPress();
      return;
    }

    if (!isViewportCanvas(e.target)) {
      clearPress();
      return;
    }

    clearPress();
    const snapshot = {
      id: pid,
      clientX: e.clientX,
      clientY: e.clientY,
      isTouch: e.pointerType !== 'mouse',
      hadGizmoTap: Boolean(viewport.gizmo?._tap),
      hadGizmoMulti: Boolean(viewport.gizmo?.multiSelectMode),
      hadEditTap: Boolean(edit.active && edit.editor?._tap),
      hadEditMulti: Boolean(edit.active && edit.editor?.multiSelectMode),
    };
    press = snapshot;

    pressTimer = setTimeout(() => {
      pressTimer = 0;
      if (!press || press.id !== snapshot.id || activePointers.size !== 1) return;
      if (
        viewport.gizmo?.drag ||
        sculpt.sculptor?.isStroking ||
        paint.painter?.isStroking ||
        edit.editor?.drag ||
        edit.editor?.cutDrag ||
        edit.editor?.boxDrag?.started
      ) {
        clearPress();
        return;
      }

      if (
        !edit.active &&
        !sculpt.active &&
        !paint.active &&
        !(rig.active && (rig.rigger.boneTool || rig.rigger.weightPaint)) &&
        viewport.gizmo?.enabled
      ) {
        const gizmoConsumedLongPress =
          (snapshot.hadGizmoTap && !viewport.gizmo._tap) ||
          viewport.gizmo.multiSelectMode !== snapshot.hadGizmoMulti;
        if (gizmoConsumedLongPress) {
          clearPress();
          return;
        }
      }

      if (edit.active && edit.editor?.enabled) {
        const editConsumedLongPress =
          (snapshot.hadEditTap && !edit.editor._tap) ||
          edit.editor.multiSelectMode !== snapshot.hadEditMulti;
        if (editConsumedLongPress) {
          clearPress();
          return;
        }
      }

      clearPress();
      suppressContextUntil = performance.now() + 600;
      viewport.controls?.cancelPointer?.(snapshot.id);
      if (viewport.gizmo) {
        viewport.gizmo._clearLongPress?.();
        viewport.gizmo._tap = null;
      }
      if (edit.editor) {
        edit.editor._clearLongPress?.();
        edit.editor._tap = null;
        if (edit.editor.boxDrag && !edit.editor.boxDrag.started) {
          edit.editor.cancelBoxDrag?.();
        }
      }

      if (snapshot.isTouch && typeof navigator !== 'undefined' && navigator.vibrate) {
        try { navigator.vibrate(16); } catch (_) {}
      }
      openViewportContextMenu(snapshot.clientX, snapshot.clientY);
    }, LONG_PRESS_MS);
  }, { capture: true });

  const onMove = (e) => {
    if (!press || (e.pointerId ?? 1) !== press.id) return;
    const tol = press.isTouch ? 8 : 5;
    if (Math.hypot(e.clientX - press.clientX, e.clientY - press.clientY) > tol) {
      clearPress();
    }
  };

  const onEnd = (e) => {
    activePointers.delete(e.pointerId ?? 1);
    if (press && (e.pointerId ?? 1) === press.id) {
      clearPress();
    }
  };

  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerup', onEnd, { passive: true });
  window.addEventListener('pointercancel', onEnd, { passive: true });
  wrap.addEventListener('wheel', clearPress, { passive: true });
  window.addEventListener('blur', () => {
    activePointers.clear();
    clearPress();
  });

  wrap.addEventListener('contextmenu', (e) => {
    if (isViewportCanvas(e.target) && (performance.now() < suppressContextUntil || !menu.hidden)) {
      e.preventDefault();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (menu.hidden) return;
    if (!e.target.closest('#viewport-context-menu')) {
      closeViewportContextMenu();
    }
  }, { capture: true });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      closeViewportContextMenu();
    }
  });

  dom.btnCtxNeutral?.addEventListener('click', () => {
    setNeutralLightingMode(!lighting.neutralMode);
    syncViewportContextMenu();
  });

  dom.btnCtxShadows?.addEventListener('click', () => {
    if (!lighting.dirLight) return;
    if (lighting.neutralMode) {
      setNeutralLightingMode(false, { silent: true });
      lighting.dirLight.castShadow = true;
    } else {
      lighting.dirLight.castShadow = !lighting.dirLight.castShadow;
    }
    if (dom.dirShadows) dom.dirShadows.checked = Boolean(lighting.dirLight.castShadow);
    syncShadowResolutionUI();
    syncViewportContextMenu();
    setStatus(lighting.dirLight.castShadow ? 'Sombras activadas.' : 'Sombras desactivadas.');
  });

  dom.btnCtxEnv?.addEventListener('click', () => {
    const currentlyOn = !lighting.neutralMode && Boolean(viewport.scene?.environment);
    if (currentlyOn) {
      applyEnvironmentPreset('none');
      setStatus('Reflejos HDRI/IBL desactivados.');
    } else {
      if (lighting.neutralMode) {
        setNeutralLightingMode(false, { silent: true });
      }
      const preset = lighting.lastEnvPreset && lighting.lastEnvPreset !== 'none'
        ? lighting.lastEnvPreset
        : 'studio';
      applyEnvironmentPreset(preset);
      setStatus('Reflejos HDRI/IBL activados.');
    }
    syncViewportContextMenu();
  });

  dom.btnCtxFloor?.addEventListener('click', () => {
    if (!sceneStore.floor) return;
    sceneStore.floor.visible = !sceneStore.floor.visible;
    if (dom.floorVisible) dom.floorVisible.checked = Boolean(sceneStore.floor.visible);
    syncViewportContextMenu();
  });

  dom.btnCtxGrid?.addEventListener('click', () => {
    if (!sceneStore.grid) return;
    sceneStore.grid.visible = !sceneStore.grid.visible;
    if (dom.gridVisible) dom.gridVisible.checked = Boolean(sceneStore.grid.visible);
    syncViewportContextMenu();
  });

  dom.btnCtxResetCam?.addEventListener('click', () => {
    closeViewportContextMenu();
    resetCamera();
    setStatus('Cámara centrada.');
  });
}
