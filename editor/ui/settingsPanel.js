import { Renderer, Fog, Color, SHADOW_RESOLUTIONS, SHADOW_QUALITY } from '../../made3d.module.js';
import { isMobilePhoneDevice } from '../../src/core/viewportCoords.js';
import { dom, setStatus } from '../dom.js';
import { viewport, sceneStore, lighting, cameraView } from '../store.js';
import { resizeRenderer, syncShadowResolutionUI, switchRenderBackend } from '../viewport.js';
import { exitCameraView } from '../cameraView.js';
import { applyEnvironmentPreset, loadEnvironmentFile } from '../sceneActions.js';
import { closeAllPopovers } from './popovers.js';
import { drawTimelineCanvas, syncAnimationUI } from '../animationController.js';

export function bindSettingsPanel() {
  if (dom.dirShadowRes) {
    const qualityTags = {};
    const qualityLabels = { low: 'Baja', medium: 'Media', high: 'Alta', ultra: 'Ultra' };
    for (const [k, sz] of Object.entries(SHADOW_QUALITY)) {
      if (!qualityTags[sz]) qualityTags[sz] = qualityLabels[k] || k;
    }
    dom.dirShadowRes.innerHTML = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Automática';
    autoOpt.selected = true;
    dom.dirShadowRes.appendChild(autoOpt);
    SHADOW_RESOLUTIONS.forEach((res) => {
      const opt = document.createElement('option');
      opt.value = String(res);
      const tag = res === 256 ? 'Mínima' : (qualityTags[res] || '');
      opt.textContent = tag ? `${res} px (${tag})` : `${res} px`;
      dom.dirShadowRes.appendChild(opt);
    });
  }

  if (dom.renderBackend) {
    const webgpuOk = Renderer.isWebGPUSupported();
    const webgpuOpt = dom.renderBackend.querySelector('option[value="webgpu"]');
    if (webgpuOpt) {
      webgpuOpt.disabled = !webgpuOk;
      webgpuOpt.textContent = webgpuOk ? 'WebGPU' : 'WebGPU (no soportado)';
    }
  }

  // HDRI
  dom.envPreset?.addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'custom') return;
    applyEnvironmentPreset(val);
    setStatus(val === 'none' ? 'HDRI/IBL desactivado.' : `Entorno IBL: ${e.target.selectedOptions?.[0]?.textContent || val}`);
  });
  dom.envIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (dom.envIntensityVal) dom.envIntensityVal.textContent = v.toFixed(2);
    if (viewport.scene) viewport.scene.environmentIntensity = v;
  });
  dom.btnEnvUpload?.addEventListener('click', () => dom.envFileInput?.click());
  dom.envFileInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try { await loadEnvironmentFile(file); }
    catch (err) { setStatus(`Error cargando HDRI: ${err.message}`, true); }
  });
  dom.btnEnvClear?.addEventListener('click', () => {
    applyEnvironmentPreset('none');
    setStatus('HDRI/IBL quitado.');
  });

  // Luces
  dom.dirIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.dirIntensityVal.textContent = v.toFixed(1);
    if (lighting.dirLight) lighting.dirLight.intensity = v;
  });
  dom.dirColor?.addEventListener('input', (e) => {
    if (lighting.dirLight) lighting.dirLight.color.set(e.target.value);
  });
  dom.dirShadows?.addEventListener('change', (e) => {
    if (!lighting.dirLight) return;
    lighting.dirLight.castShadow = e.target.checked;
    syncShadowResolutionUI();
  });
  dom.dirShadowRes?.addEventListener('change', (e) => {
    if (!lighting.dirLight) return;
    const val = e.target.value;
    if (val === 'auto') {
      lighting.dirLight.shadow.mapSize = 1024;
      lighting.dirLight.shadow.autoQuality = true;
    } else {
      const size = Math.max(64, parseInt(val, 10) || 1024);
      lighting.dirLight.shadow.mapSize = size;
      lighting.dirLight.shadow.autoQuality = false;
    }
    syncShadowResolutionUI();
  });
  dom.dirShadowSoft?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.dirShadowSoftVal.textContent = v.toFixed(2);
    if (lighting.dirLight?.shadow) lighting.dirLight.shadow.radius = v;
  });
  dom.dirOrbit?.addEventListener('change', (e) => { lighting.orbitLight = e.target.checked; });

  dom.pointIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.pointIntensityVal.textContent = v.toFixed(1);
    if (lighting.pointLight) lighting.pointLight.intensity = v;
  });
  dom.pointColor?.addEventListener('input', (e) => {
    if (lighting.pointLight) lighting.pointLight.color.set(e.target.value);
  });
  dom.ambIntensity?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    dom.ambIntensityVal.textContent = v.toFixed(2);
    if (lighting.ambientLight) lighting.ambientLight.intensity = v;
  });

  // Escenario
  const applyFog = () => {
    viewport.scene.fog = lighting.fogEnabled ? new Fog(lighting.fogColorHex, 8, lighting.fogFar) : null;
  };
  dom.fogEnabled?.addEventListener('change', (e) => { lighting.fogEnabled = e.target.checked; applyFog(); });
  dom.fogFar?.addEventListener('input', (e) => {
    lighting.fogFar = Number(e.target.value);
    dom.fogFarVal.textContent = String(lighting.fogFar);
    applyFog();
  });
  dom.bgColor?.addEventListener('input', (e) => {
    lighting.fogColorHex = e.target.value;
    viewport.scene.background = new Color(lighting.fogColorHex);
    applyFog();
  });
  dom.gridVisible?.addEventListener('change', (e) => { sceneStore.grid.visible = e.target.checked; });
  dom.floorVisible?.addEventListener('change', (e) => { sceneStore.floor.visible = e.target.checked; });

  // Visor & Motor
  dom.cameraType?.addEventListener('change', (e) => {
    if (cameraView.activeSceneCam) exitCameraView({ restoreSnapshot: false });
    const useOrtho = e.target.value === 'orthographic';
    const prevCam = viewport.camera;
    const nextCam = useOrtho ? viewport.orthoCam : viewport.perspCam;
    nextCam.position.copy(prevCam.position);
    viewport.camera = nextCam;
    viewport.controls.camera = nextCam;
    viewport.controls.syncFromCamera();
    if (viewport.gizmo) viewport.gizmo.camera = nextCam;
    dom.fovRow.hidden = useOrtho;
    resizeRenderer();
  });
  dom.cameraFov?.addEventListener('input', (e) => {
    const fov = Number(e.target.value);
    dom.cameraFovVal.textContent = `${fov}°`;
    viewport.perspCam.fov = fov;
    viewport.perspCam.updateProjection();
  });
  dom.renderQuality?.addEventListener('change', (e) => {
    viewport.renderer.setQuality(e.target.value);
    resizeRenderer();
    syncShadowResolutionUI();
  });
  dom.renderBackend?.addEventListener('change', async (e) => {
    const pref = e.target.value;
    const prevBackend = viewport.renderer ? viewport.renderer.backendType : 'webgl2';
    try {
      setStatus(`Cambiando motor gráfico a ${pref.toUpperCase()}...`);
      const next = await switchRenderBackend(pref);
      if (next) setStatus(`Motor activo: ${next.isWebGPU ? 'WebGPU' : 'WebGL2'}.`);
    } catch (err) {
      if (dom.renderBackend) dom.renderBackend.value = prevBackend;
      setStatus(err && err.message ? err.message : 'No se pudo cambiar de motor gráfico.', true);
    }
  });
  dom.btnRetryWebgl?.addEventListener('click', () => window.location.reload());

  // Modo móvil horizontal (90°) — habilitado únicamente en teléfonos
  let mobileLandscapeEnabled = false;
  let rotateTimer = 0;
  let countdownInterval = 0;

  const clearRotateNoticeTimers = () => {
    if (rotateTimer) {
      clearTimeout(rotateTimer);
      rotateTimer = 0;
    }
    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = 0;
    }
  };

  const syncCssRotation = () => {
    const html = document.documentElement;
    const isPortrait = window.innerWidth <= window.innerHeight;
    const shouldCssRotate = Boolean(mobileLandscapeEnabled && isPortrait);
    const hadRotate = html.classList.contains('is-mobile-landscape-90');
    html.classList.toggle('is-mobile-landscape-90', shouldCssRotate);

    if (dom.bottomDock && dom.undoRedoBar) {
      if (shouldCssRotate) {
        if (dom.dockUndoSep) dom.dockUndoSep.hidden = false;
        if (dom.undoRedoBar.parentElement !== dom.bottomDock) {
          dom.bottomDock.appendChild(dom.undoRedoBar);
        }
      } else {
        if (dom.dockUndoSep) dom.dockUndoSep.hidden = true;
        if (dom.undoRedoBar.parentElement === dom.bottomDock && dom.bottomDock.parentElement) {
          dom.bottomDock.parentElement.insertBefore(dom.undoRedoBar, dom.bottomDock);
        }
      }
    }

    if (viewport.gizmo) viewport.gizmo._rect = null;
    if (hadRotate !== shouldCssRotate) {
      window.dispatchEvent(new Event('resize'));
    }
    resizeRenderer();
    if (viewport.appMode === 'animacion') {
      syncAnimationUI();
      requestAnimationFrame(() => drawTimelineCanvas());
    }
  };

  const syncMobileButtonAvailability = () => {
    const isPhone = isMobilePhoneDevice();
    if (!isPhone && mobileLandscapeEnabled) {
      mobileLandscapeEnabled = false;
      clearRotateNoticeTimers();
      if (dom.mobileRotateModal) dom.mobileRotateModal.hidden = true;
      document.documentElement.classList.remove('is-mobile-landscape-90');
      if (dom.dockUndoSep) dom.dockUndoSep.hidden = true;
      if (dom.undoRedoBar && dom.bottomDock && dom.undoRedoBar.parentElement === dom.bottomDock && dom.bottomDock.parentElement) {
        dom.bottomDock.parentElement.insertBefore(dom.undoRedoBar, dom.bottomDock);
      }
    }
    if (dom.btnMobileLandscape) {
      dom.btnMobileLandscape.disabled = !isPhone;
      dom.btnMobileLandscape.classList.toggle('is-active', isPhone && mobileLandscapeEnabled);
      dom.btnMobileLandscape.setAttribute('aria-pressed', isPhone && mobileLandscapeEnabled ? 'true' : 'false');
      dom.btnMobileLandscape.title = !isPhone
        ? 'Solo disponible en teléfonos móviles'
        : mobileLandscapeEnabled
        ? 'Volver al modo vertical normal'
        : 'Girar la web 90 grados a modo horizontal';
    }
    if (dom.mobileLandscapeState) {
      dom.mobileLandscapeState.textContent = !isPhone
        ? 'Solo teléfono'
        : mobileLandscapeEnabled
        ? 'Activo (90°)'
        : 'Off';
    }
  };

  const closeMobileRotateNotice = () => {
    clearRotateNoticeTimers();
    if (dom.mobileRotateModal) dom.mobileRotateModal.hidden = true;
  };

  const activateMobileLandscape = async ({ fromUserClick = false } = {}) => {
    if (!isMobilePhoneDevice()) {
      closeMobileRotateNotice();
      syncMobileButtonAvailability();
      return;
    }
    closeMobileRotateNotice();
    mobileLandscapeEnabled = true;
    syncMobileButtonAvailability();

    if (fromUserClick) {
      try {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } catch (_) {}
      try {
        if (screen.orientation && typeof screen.orientation.lock === 'function') {
          await screen.orientation.lock('landscape');
        }
      } catch (_) {}
    }

    syncCssRotation();
    setStatus('Modo horizontal móvil (90°) activado. Toca de nuevo en Ajustes para desactivar.');
  };

  const disableMobileLandscape = ({ silent = false } = {}) => {
    closeMobileRotateNotice();
    mobileLandscapeEnabled = false;
    try {
      if (screen.orientation && typeof screen.orientation.unlock === 'function') {
        screen.orientation.unlock();
      }
    } catch (_) {}
    try {
      if (document.fullscreenElement && typeof document.exitFullscreen === 'function') {
        document.exitFullscreen().catch(() => {});
      }
    } catch (_) {}
    syncMobileButtonAvailability();
    syncCssRotation();
    if (!silent) {
      setStatus('Modo horizontal móvil (90°) desactivado.');
    }
  };

  const openMobileRotateNotice = () => {
    if (!isMobilePhoneDevice()) return;
    closeAllPopovers();
    clearRotateNoticeTimers();
    if (!dom.mobileRotateModal) {
      void activateMobileLandscape({ fromUserClick: true });
      return;
    }
    let secondsLeft = 2;
    if (dom.mobileRotateCountdown) {
      dom.mobileRotateCountdown.textContent = `Girando automáticamente en ${secondsLeft} s...`;
    }
    dom.mobileRotateModal.hidden = false;
    countdownInterval = setInterval(() => {
      secondsLeft = Math.max(0, secondsLeft - 1);
      if (dom.mobileRotateCountdown) {
        dom.mobileRotateCountdown.textContent =
          secondsLeft > 0 ? `Girando automáticamente en ${secondsLeft} s...` : 'Girando a modo horizontal...';
      }
    }, 850);
    rotateTimer = setTimeout(() => {
      void activateMobileLandscape({ fromUserClick: false });
    }, 1700);
  };

  dom.btnMobileLandscape?.addEventListener('click', () => {
    if (!isMobilePhoneDevice()) {
      syncMobileButtonAvailability();
      return;
    }
    if (mobileLandscapeEnabled) {
      disableMobileLandscape();
    } else {
      openMobileRotateNotice();
    }
  });

  dom.btnMobileRotateNow?.addEventListener('click', () => {
    void activateMobileLandscape({ fromUserClick: true });
  });
  dom.btnMobileRotateCancel?.addEventListener('click', closeMobileRotateNotice);
  dom.mobileRotateModal?.addEventListener('click', (e) => {
    if (e.target === dom.mobileRotateModal) closeMobileRotateNotice();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.mobileRotateModal && !dom.mobileRotateModal.hidden) {
      closeMobileRotateNotice();
    }
  });

  const handleViewportChange = () => {
    syncMobileButtonAvailability();
    if (mobileLandscapeEnabled) syncCssRotation();
  };
  window.addEventListener('resize', handleViewportChange);
  window.addEventListener('orientationchange', handleViewportChange);
  if (typeof window.matchMedia === 'function') {
    const coarseMq = window.matchMedia('(pointer: coarse)');
    coarseMq.addEventListener?.('change', handleViewportChange);
  }

  syncMobileButtonAvailability();
}
