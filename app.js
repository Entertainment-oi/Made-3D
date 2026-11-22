import { SkeletonHelper } from './src/modules/rigging.js';
import { dom } from './editor/dom.js';
import {
  clock,
  viewport,
  sceneStore,
  lighting,
  cameraView,
  recorder,
  sculpt,
  edit,
  debug,
  getCameraMeta,
  isDescendantOrSelf,
} from './editor/store.js';
import { SystemScheduler } from './editor/loop.js';
import { history } from './editor/history.js';
import {
  initEngine,
  selectObject,
  syncCameraHelperSelection,
} from './editor/viewport.js';
import {
  updateViewfinderOverlay,
  exitCameraView,
  stopCameraVideo,
  updateVideoRecordingUI,
} from './editor/cameraView.js';
import {
  syncSculptUI,
  renderSculptOverlay,
} from './editor/sculptController.js';
import {
  setEditMode,
  syncEditUI,
  renderEditOverlay,
} from './editor/editController.js';
import {
  initDefaultScene,
} from './editor/sceneActions.js';
import {
  bindUI,
  syncSelectedUI,
  syncTransformInputs,
  renderObjectList,
} from './editor/inspectorUI.js';

history.setHooks({
  selectObject,
  syncTransformInputs,
  syncCameraHelperSelection,
  syncSelectedUI,
  syncSculptUI,
  syncEditUI,
  setEditMode,
  renderObjectList,
  invalidateRigHelpers: () =>
    SkeletonHelper.invalidateScene(viewport.scene, {
      gizmo: viewport.gizmo,
      picker: viewport.picker,
      mixer: sceneStore.mixer,
    }),
  exitCameraView,
  stopCameraVideo,
});

export const scheduler = new SystemScheduler({ clock, debug });
viewport.scheduler = scheduler;

scheduler.register('lightOrbit', (_dt, ctx) => {
  if (lighting.orbitLight && lighting.dirLight) {
    lighting.dirLight.position.set(
      Math.cos(ctx.elapsed * 0.65) * 9,
      9.5,
      Math.sin(ctx.elapsed * 0.65) * 9
    );
  }
});

scheduler.register('spinObjects', (dt) => {
  const sculptingMesh =
    sculpt.active && sculpt.sculptor.isStroking ? sculpt.sculptor.activeMesh : null;
  const editingMesh =
    edit.active && edit.editor.drag ? edit.editor.mesh : null;
  for (const obj of sceneStore.spinObjects) {
    const dragging = viewport.gizmo?.drag && viewport.gizmo.objects.includes(obj);
    const beingSculpted =
      Boolean(sculptingMesh) && (obj === sculptingMesh || isDescendantOrSelf(sculptingMesh, obj));
    const beingEdited =
      Boolean(editingMesh) && (obj === editingMesh || isDescendantOrSelf(editingMesh, obj));
    if (!dragging && !beingSculpted && !beingEdited) {
      obj.rotation.y += dt * 0.85;
      if (obj === sceneStore.selected) syncTransformInputs();
    }
  }
});

scheduler.register('animationMixer', (dt) => {
  if (sceneStore.mixer && sceneStore.animPlaying) {
    sceneStore.mixer.update(dt);
  }
});

scheduler.register('cameraViewfinder', (_dt, ctx) => {
  let activeViewportCam = viewport.camera;
  if (cameraView.activeSceneCam) {
    const cam = cameraView.activeSceneCam;
    if (!cameraView.camViewLocked && viewport.controls.update()) {
      if (sceneStore.selected === cam) syncTransformInputs();
    }
    const vf = updateViewfinderOverlay();
    if (vf && cameraView.viewCam) {
      cameraView.viewCam.syncFromViewfinder(cam, vf.vpW, vf.vpH, vf.frameH);
      if (viewport.gizmo) viewport.gizmo.camera = cameraView.viewCam;
      activeViewportCam = cameraView.viewCam;
    } else {
      activeViewportCam = cam;
    }
  } else if (viewport.controls) {
    viewport.controls.update();
  }
  ctx.activeViewportCam = activeViewportCam;
});

scheduler.register('videoRecorder', (_dt, ctx) => {
  if (ctx.skipVideoRecorder) return;
  if (recorder.instance && recorder.instance.recording && !recorder.stopping) {
    recorder.instance.includeGrid = Boolean(getCameraMeta(recorder.camera).includeGrid);
    ctx.didCaptureFrame = recorder.instance.captureFrame(false, {
      viewportCamera: ctx.activeViewportCam,
      deferViewportRender: true,
    });
    ctx.alreadyRenderedViewport = ctx.didCaptureFrame && recorder.instance.didRenderViewport;
    updateVideoRecordingUI();
    if (recorder.duration > 0 && recorder.instance.elapsed >= recorder.duration) {
      stopCameraVideo();
    }
  }
});

scheduler.register('render', (_dt, ctx) => {
  if (ctx.skipRender) return;
  if (!ctx.alreadyRenderedViewport && viewport.renderer && viewport.scene && ctx.activeViewportCam) {
    viewport.renderer.render(viewport.scene, ctx.activeViewportCam, {
      reuseShadowMap: Boolean(ctx.didCaptureFrame),
    });
  }
});

scheduler.register('editOverlay', (_dt, ctx) => {
  renderEditOverlay(ctx.activeViewportCam);
});

scheduler.register('sculptOverlay', (_dt, ctx) => {
  renderSculptOverlay(ctx.activeViewportCam);
});

if (await initEngine()) {
  if (dom.renderBackend && viewport.renderer) {
    dom.renderBackend.value = viewport.renderer.backendType;
  }
  bindUI();
  initDefaultScene();
  scheduler.start();
}
