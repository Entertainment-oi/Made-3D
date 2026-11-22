import { PerspectiveCamera, Vec3, Quat } from '../made3d.module.js';
import { CameraHelper } from '../src/modules/helpers.js';
import { dom, DEFAULT_HUD_HINT, setStatus, downloadBlob } from './dom.js';
import {
  clock,
  viewport,
  sceneStore,
  cameraView,
  recorder,
  getCameraMeta,
  setCameraMeta,
  isInScene,
} from './store.js';
import { syncCameraHelperSelection, selectObject } from './viewport.js';
import { syncSelectedUI, renderObjectList } from './inspectorUI.js';
import { registerUserObject } from './sceneActions.js';

export function getCameraResolution(cam) {
  const safe =
    cam && typeof cam.getSafeRenderSize === 'function'
      ? cam.getSafeRenderSize(viewport.renderer)
      : viewport.renderer?.clampRenderSize(cam?.renderWidth || 1920, cam?.renderHeight || 1080, {
          minSize: 64,
          maxSize: 7680,
          preserveAspect: true,
        }) || { width: 1920, height: 1080, clamped: false, maxWidth: 7680, maxHeight: 7680 };
  return {
    w: safe.width,
    h: safe.height,
    clamped: safe.clamped,
    maxW: safe.maxWidth,
    maxH: safe.maxHeight,
  };
}

export function addSceneCamera(opts = {}) {
  const srcCam = cameraView.activeSceneCam || viewport.camera;
  if (cameraView.activeSceneCam) {
    exitCameraView({ restoreSnapshot: false });
  }
  srcCam.updateWorldMatrix(true, false);

  sceneStore.cameraCounter++;
  const cam = new PerspectiveCamera(viewport.perspCam ? viewport.perspCam.fov : 50, 16 / 9, 0.1, 400);
  cam.position.copy(srcCam.getWorldPosition(new Vec3()));
  cam.quaternion.copy(srcCam.getWorldQuaternion(new Quat()));
  const initRes = getCameraResolution({ renderWidth: opts.width || 1920, renderHeight: opts.height || 1080 });
  cam.renderWidth = initRes.w;
  cam.renderHeight = initRes.h;
  cam.aspect = cam.renderWidth / cam.renderHeight;
  cam.updateProjection();

  const helper = new CameraHelper(cam);
  cam.add(helper);
  setCameraMeta(cam, { showThirds: true, includeGrid: false, helper });

  // Alejar ligeramente la cámara libre del editor para ver de inmediato la cámara colocada y su pirámide
  const back = new Vec3(0, 0, 1).applyQuaternion(cam.quaternion).normalize();
  const right = new Vec3(1, 0, 0).applyQuaternion(cam.quaternion).normalize();
  viewport.camera.position
    .copy(cam.position)
    .addScaledVector(back, 2.4)
    .addScaledVector(right, 0.85);
  viewport.camera.position.y += 0.65;
  viewport.controls.target.copy(cam.position);
  viewport.controls.syncFromCamera();

  const camName = opts.name || `Cámara ${sceneStore.cameraCounter}`;
  registerUserObject(cam, camName, opts.recordHistory !== false);
  selectObject(cam);
  setStatus(`"${camName}" colocada en tu vista. Muévela con el gizmo o pulsa "Entrar a cámara".`);
  return cam;
}

export function updateViewfinderOverlay() {
  const cam = cameraView.activeSceneCam;
  if (!cam) {
    if (dom.cameraViewfinder) dom.cameraViewfinder.hidden = true;
    return null;
  }
  if (dom.cameraViewfinder) dom.cameraViewfinder.hidden = false;
  const vpW = Math.max(1, dom.viewportWrap.clientWidth || dom.canvas.clientWidth || 1);
  const vpH = Math.max(1, dom.viewportWrap.clientHeight || dom.canvas.clientHeight || 1);
  const { w: rw, h: rh } = getCameraResolution(cam);
  const frame = PerspectiveCamera.computeViewfinderFrame(vpW, vpH, rw / rh);

  dom.vfMaskTop.style.cssText = `left:0;top:0;width:100%;height:${Math.max(0, frame.top)}px;`;
  dom.vfMaskBottom.style.cssText = `left:0;top:${frame.bottom}px;width:100%;height:${Math.max(0, vpH - frame.bottom)}px;`;
  dom.vfMaskLeft.style.cssText = `left:0;top:${Math.max(0, frame.top)}px;width:${Math.max(0, frame.left)}px;height:${frame.height}px;`;
  dom.vfMaskRight.style.cssText = `left:${frame.right}px;top:${Math.max(0, frame.top)}px;width:${Math.max(0, vpW - frame.right)}px;height:${frame.height}px;`;
  dom.vfFrame.style.cssText = `left:${frame.left}px;top:${frame.top}px;width:${frame.width}px;height:${frame.height}px;`;

  const meta = getCameraMeta(cam);
  dom.vfThirds.hidden = meta.showThirds === false;
  dom.vfLabel.textContent = `${cam.name || 'Cámara'} · ${rw}×${rh} · FOV ${Math.round(cam.fov)}°`;
  dom.btnVfLock.classList.toggle('is-active', cameraView.camViewLocked);
  dom.btnVfLock.textContent = cameraView.camViewLocked ? 'Cámara fijada' : 'Fijar cámara';

  return { vpW, vpH, frameW: frame.width, frameH: frame.height };
}

export function updateSceneCameraProps(cam) {
  if (!cam || !cam.isCamera) return;
  cam.updateProjection();
  const meta = getCameraMeta(cam);
  if (meta.helper) meta.helper.update();
  if (cameraView.activeSceneCam === cam) updateViewfinderOverlay();
}

export function setCamViewLocked(locked) {
  cameraView.camViewLocked = Boolean(locked);
  if (dom.sceneCamLock) dom.sceneCamLock.checked = cameraView.camViewLocked;
  if (viewport.controls) viewport.controls.enabled = !(cameraView.activeSceneCam && cameraView.camViewLocked);
  if (cameraView.activeSceneCam) updateViewfinderOverlay();
}

export function enterCameraView(cam) {
  if (!cam || !cam.isCamera) return;
  if (!cameraView.activeSceneCam) {
    cameraView.editorViewSnapshot = {
      position: viewport.camera.position.clone(),
      target: viewport.controls.target.clone(),
      isOrtho: viewport.camera === viewport.orthoCam,
      fov: viewport.perspCam ? viewport.perspCam.fov : 50,
    };
  }
  if (viewport.camera === viewport.orthoCam && viewport.perspCam) {
    viewport.camera = viewport.perspCam;
    if (dom.cameraType) dom.cameraType.value = 'perspective';
    if (dom.fovRow) dom.fovRow.hidden = false;
  }

  cameraView.activeSceneCam = cam;
  if (!cameraView.viewCam) {
    cameraView.viewCam = new PerspectiveCamera(cam.fov, 16 / 9, 0.05, 800);
  }
  cameraView.viewCam.sourceCamera = cam;

  cam.updateWorldMatrix(true, false);
  const baseDist = cameraView.editorViewSnapshot
    ? cameraView.editorViewSnapshot.position.distanceTo(cameraView.editorViewSnapshot.target)
    : 6;
  const dist = Math.max(2, Math.min(24, baseDist || 6));
  viewport.controls.camera = cam;
  viewport.controls.syncTargetFromCamera(dist);
  viewport.controls.enabled = !cameraView.camViewLocked;

  if (viewport.gizmo) {
    viewport.gizmo.camera = cameraView.viewCam;
    viewport.gizmo.visible = sceneStore.selected !== cam;
    viewport.gizmo.deselectOnEscape = false;
  }
  if (recorder.instance) {
    recorder.instance.viewportCamera = cameraView.viewCam;
  }

  if (dom.hudHint) dom.hudHint.textContent = 'Vista cámara · Arrastra para encuadrar · Esc: salir · Clic en objeto para editar';
  updateViewfinderOverlay();
  syncSelectedUI();
  renderObjectList();
  setStatus(`Viendo desde "${cam.name || 'Cámara'}". Pulsa Esc o "Salir vista cámara" para volver.`);
}

export function exitCameraView({ restoreSnapshot = true } = {}) {
  if (!cameraView.activeSceneCam) return;
  const prevCam = cameraView.activeSceneCam;
  cameraView.activeSceneCam = null;
  if (dom.cameraViewfinder) dom.cameraViewfinder.hidden = true;
  if (viewport.controls) viewport.controls.enabled = true;

  if (restoreSnapshot && cameraView.editorViewSnapshot) {
    const snap = cameraView.editorViewSnapshot;
    if (snap.isOrtho && viewport.orthoCam) {
      viewport.camera = viewport.orthoCam;
      if (dom.cameraType) dom.cameraType.value = 'orthographic';
      if (dom.fovRow) dom.fovRow.hidden = true;
    } else if (viewport.perspCam) {
      viewport.camera = viewport.perspCam;
      if (dom.cameraType) dom.cameraType.value = 'perspective';
      if (dom.fovRow) dom.fovRow.hidden = false;
    }
    if (viewport.perspCam && Number.isFinite(snap.fov)) {
      viewport.perspCam.fov = snap.fov;
      viewport.perspCam.updateProjection();
      if (dom.cameraFov) dom.cameraFov.value = Math.round(snap.fov);
      if (dom.cameraFovVal) dom.cameraFovVal.textContent = `${Math.round(snap.fov)}°`;
    }
    viewport.camera.position.copy(snap.position);
    viewport.controls.camera = viewport.camera;
    viewport.controls.target.copy(snap.target);
    viewport.controls.syncFromCamera();
  } else if (viewport.controls) {
    viewport.controls.camera = viewport.camera;
    viewport.controls.syncFromCamera();
  }
  cameraView.editorViewSnapshot = null;

  if (viewport.gizmo) {
    viewport.gizmo.camera = viewport.camera;
    viewport.gizmo.visible = true;
    viewport.gizmo.deselectOnEscape = true;
    if (sceneStore.selected === prevCam && isInScene(prevCam)) {
      viewport.gizmo.attach(prevCam);
    }
  }
  if (recorder.instance) {
    recorder.instance.viewportCamera = viewport.camera;
  }
  if (dom.hudHint) dom.hudHint.textContent = DEFAULT_HUD_HINT;
  syncCameraHelperSelection();
  syncSelectedUI();
  renderObjectList();
}

export async function renderCameraSnapshot(cam) {
  if (!cam || !cam.isCamera || !viewport.renderer) return;
  const { w, h } = getCameraResolution(cam);
  const mime = dom.sceneCamFormat ? dom.sceneCamFormat.value : 'image/png';
  const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
  const includeGrid = Boolean(getCameraMeta(cam).includeGrid);
  const prevLabel = dom.btnCamRender ? dom.btnCamRender.textContent : '';
  if (dom.btnCamRender) {
    dom.btnCamRender.disabled = true;
    dom.btnCamRender.textContent = `Renderizando ${w}×${h}...`;
  }
  setStatus(`Renderizando captura de "${cam.name || 'Cámara'}" a ${w}×${h}...`);

  try {
    const blob = await viewport.renderer.captureBlob(viewport.scene, cam, w, h, {
      mimeType: mime,
      quality: 0.94,
      includeGrid,
      viewportCamera: cameraView.activeSceneCam ? cameraView.viewCam : viewport.camera,
    });
    if (!blob) throw new Error('No se pudo generar la imagen.');
    const safeName = (cam.name || 'render_made3d').replace(/[^\w\-]+/g, '_');
    const filename = `${safeName}_${w}x${h}.${ext}`;
    downloadBlob(blob, filename);
    setStatus(`Render completado: ${filename} (${w}×${h}, ${(blob.size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    setStatus(`Error al renderizar: ${err.message}`, true);
  } finally {
    if (dom.btnCamRender) {
      dom.btnCamRender.disabled = Boolean(recorder.instance?.recording || recorder.stopping);
      dom.btnCamRender.textContent = prevLabel || 'Renderizar imagen';
    }
  }
}

function formatRecTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function updateVideoRecordingUI() {
  const rec = recorder.instance;
  const active = Boolean((rec && rec.recording) || recorder.stopping);

  if (dom.btnCamRender) dom.btnCamRender.disabled = active;
  if (dom.btnVfRender) dom.btnVfRender.disabled = active;

  if (!active || !rec) {
    if (dom.recIndicator) dom.recIndicator.hidden = true;
    if (dom.btnCamVideo) {
      dom.btnCamVideo.classList.remove('is-recording');
      dom.btnCamVideo.disabled = false;
      dom.btnCamVideo.textContent = 'Grabar video';
    }
    if (dom.btnVfVideo) {
      dom.btnVfVideo.classList.remove('is-recording');
      dom.btnVfVideo.disabled = false;
      dom.btnVfVideo.textContent = 'Grabar video';
    }
    return;
  }

  const timeStr = formatRecTime(rec.elapsed);
  const durPart = recorder.duration > 0 ? ` / ${formatRecTime(recorder.duration)}` : '';
  const liveFps = rec.mode === 'fixed'
    ? `${rec.fps} fps fijos`
    : `${(rec.elapsed > 0.25 ? (rec.encodedFrames || rec.frames) / rec.elapsed : rec.fps).toFixed(0)} fps`;
  if (dom.recIndicator) {
    dom.recIndicator.hidden = false;
    dom.recIndicatorText.textContent = recorder.stopping
      ? 'Finalizando video...'
      : `REC ${timeStr}${durPart} · ${rec.frames} f · ${liveFps}`;
  }

  const btnLabel = recorder.stopping ? 'Guardando video...' : `Detener (${timeStr})`;
  if (dom.btnCamVideo) {
    dom.btnCamVideo.classList.add('is-recording');
    dom.btnCamVideo.disabled = recorder.stopping;
    dom.btnCamVideo.textContent = btnLabel;
  }
  if (dom.btnVfVideo) {
    dom.btnVfVideo.classList.add('is-recording');
    dom.btnVfVideo.disabled = recorder.stopping;
    dom.btnVfVideo.textContent = btnLabel;
  }
}

function resumeSchedulerAfterFixed() {
  if (clock && typeof clock.getDelta === 'function') {
    clock.getDelta();
  }
  if (viewport.scheduler && !viewport.scheduler.running) {
    viewport.scheduler.start();
  }
}

export async function stopCameraVideo({ cancel = false } = {}) {
  const rec = recorder.instance;
  if (!rec) return;
  const wasFixed = recorder.mode === 'fixed';
  if (cancel) {
    rec.cancel();
    recorder.instance = null;
    recorder.camera = null;
    recorder.duration = 0;
    recorder.stopping = false;
    recorder.starting = false;
    recorder.mode = dom.sceneCamVideoMode?.value === 'realtime' ? 'realtime' : 'fixed';
    if (wasFixed) resumeSchedulerAfterFixed();
    updateVideoRecordingUI();
    return;
  }
  if (recorder.stopping) return;

  const cam = recorder.camera;
  recorder.stopping = true;
  updateVideoRecordingUI();

  try {
    const res = await rec.stop();
    if (res && res.blob && res.blob.size > 0) {
      const safeName = (cam?.name || 'video_made3d').replace(/[^\w\-]+/g, '_');
      const filename = `${safeName}_${res.width}x${res.height}.${res.extension}`;
      downloadBlob(res.blob, filename);
      const count = res.encodedFrames || res.frames;
      const realFps = res.duration > 0 ? (count / res.duration).toFixed(1) : res.fps;
      const engTag = res.encoder === 'webcodecs' ? 'WebCodecs' : 'MediaRecorder';
      const fpsHint = res.mode === 'realtime' && Number(realFps) < rec.fps * 0.75
        ? ' · Consejo: usa modo "Fluido (FPS fijos)" para evitar caídas de FPS'
        : '';
      setStatus(
        `Video guardado: ${filename} (${res.width}×${res.height}, ${res.duration.toFixed(1)} s, ${count} cuadros · ${realFps} fps reales · ${engTag}, ${(res.blob.size / (1024 * 1024)).toFixed(2)} MB)${fpsHint}`
      );
    } else {
      setStatus('No se recibieron cuadros de video.', true);
    }
  } catch (err) {
    setStatus(`Error al finalizar video: ${err.message}`, true);
  } finally {
    recorder.instance = null;
    recorder.camera = null;
    recorder.duration = 0;
    recorder.stopping = false;
    recorder.starting = false;
    recorder.mode = dom.sceneCamVideoMode?.value === 'realtime' ? 'realtime' : 'fixed';
    if (wasFixed) resumeSchedulerAfterFixed();
    updateVideoRecordingUI();
  }
}

async function runFixedVideoLoop(rec, duration) {
  const sched = viewport.scheduler;
  if (sched && sched.running) sched.stop();

  try {
    const res = await rec.runFixedLoop({
      duration,
      startTime: clock ? clock.elapsedTime : 0,
      autoStop: false,
      isCancelled: () => recorder.instance !== rec || recorder.stopping,
      onStep: (fixedDt, simElapsed) => {
        rec.includeGrid = Boolean(getCameraMeta(recorder.camera).includeGrid);
        let vpCam = cameraView.activeSceneCam ? cameraView.viewCam : viewport.camera;
        if (sched) {
          if (clock) clock.simElapsed = simElapsed;
          const ctx = sched.step(fixedDt, simElapsed, {
            skipVideoRecorder: true,
            skipRender: true,
          });
          if (ctx && ctx.activeViewportCam) vpCam = ctx.activeViewportCam;
        }
        return vpCam;
      },
      onFrame: () => {
        updateVideoRecordingUI();
        if (dom.statFps && viewport.renderer?.info) {
          dom.statFps.textContent = `${rec.fps} FPS (fijo)`;
        }
      },
    });
    if (res?.completed && recorder.instance === rec && !recorder.stopping) {
      await stopCameraVideo();
    }
  } catch (err) {
    if (recorder.instance === rec) {
      await stopCameraVideo({ cancel: true });
    }
    setStatus(`Error al grabar video: ${err?.message || err}`, true);
  }
}

export async function startCameraVideo(cam) {
  if (!cam || !cam.isCamera || !viewport.renderer) return;
  if (recorder.instance) {
    await stopCameraVideo();
    return;
  }
  if (recorder.starting) return;

  const { w, h } = getCameraResolution(cam);
  const fps = Math.max(12, Math.min(60, Number(dom.sceneCamFps?.value || 30)));
  const duration = Math.max(0, Number(dom.sceneCamDuration?.value || 0));
  const format = dom.sceneCamVideoFormat?.value || 'auto';
  const requestedMode = dom.sceneCamVideoMode?.value === 'realtime' ? 'realtime' : 'fixed';
  const includeGrid = Boolean(getCameraMeta(cam).includeGrid);

  recorder.starting = true;
  try {
    const rec = await viewport.renderer.createVideoRecorderAsync(viewport.scene, cam, w, h, {
      fps,
      format,
      mode: requestedMode,
      includeGrid,
      viewportCamera: cameraView.activeSceneCam ? cameraView.viewCam : viewport.camera,
    });
    await rec.prepare();
    if (rec.mode === 'fixed' && !rec._useWebCodecs) {
      rec.mode = 'realtime';
    }
    rec.start();
    recorder.instance = rec;
    recorder.camera = cam;
    recorder.duration = duration;
    recorder.stopping = false;
    recorder.mode = rec.mode;
    recorder.starting = false;
    updateVideoRecordingUI();
    const durTxt = duration > 0 ? `${duration}s` : 'manual';
    const engTxt = rec.encoderType === 'webcodecs' ? 'WebCodecs' : 'MediaRecorder';
    const modeTxt = rec.mode === 'fixed' ? 'fluido FPS fijos' : 'tiempo real';
    setStatus(
      `Grabando video de "${cam.name || 'Cámara'}" (${rec.width}×${rec.height} @ ${fps} fps · .${rec.extension} · ${engTxt} · ${modeTxt} · ${durTxt})...`
    );
    if (rec.mode === 'fixed') {
      runFixedVideoLoop(rec, duration);
    }
  } catch (err) {
    recorder.starting = false;
    resumeSchedulerAfterFixed();
    setStatus(`Error al iniciar video: ${err.message}`, true);
  }
}
