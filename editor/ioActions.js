import {
  autoScaleObject,
  loadGLTFLoader,
  loadOBJLoader,
  loadZipLoader,
  loadKTX2Loader,
  loadGLTFExporter,
  loadOBJExporter,
  loadAnimation,
} from '../made3d.module.js';
import { dom, setStatus, downloadBlob } from './dom.js';
import { viewport, sceneStore } from './store.js';
import { history } from './history.js';
import { selectObject, focusOnObject } from './viewport.js';
import { syncSelectedUI } from './inspectorUI.js';
import { registerUserObject, addPrimitive, playAnimationClip } from './sceneActions.js';
import {
  getAllSceneClips,
  getClipOwner,
  getClipKeyframeTimes,
  registerImportedClips,
} from './animationController.js';

export function buildExportTarget() {
  const scope = dom.exportScope?.value;
  if (scope === 'selected') {
    if (!sceneStore.selected) {
      setStatus('Selecciona un objeto para exportarlo.', true);
      return null;
    }
    return { target: sceneStore.selected, baseName: (sceneStore.selected.name || 'modelo').replace(/\s+/g, '_') };
  }
  const exportables = viewport.scene.getExportables({ recursive: false });
  if (!sceneStore.userObjects.length || !exportables.length) {
    setStatus('No hay objetos exportables en la escena.', true);
    return null;
  }
  return { target: viewport.scene, baseName: 'escena_made3d' };
}

function collectExportableAnimations(target) {
  const all = getAllSceneClips();
  const out = [];
  for (const clip of all) {
    if (!clip) continue;
    if (target === viewport.scene) {
      if (clip.getKeyframeTimes().length > 0) out.push(clip);
      continue;
    }
    const owner = getClipOwner(clip);
    if (clip.targetsObject(target, owner)) {
      out.push(clip);
    }
  }
  return out;
}

function promptExportAnimationSelection(clips, formatLabel) {
  const modal = dom.exportAnimModal;
  const listEl = dom.exportAnimList;
  if (!modal || !listEl) return Promise.resolve(clips);

  if (dom.exportAnimDesc) {
    dom.exportAnimDesc.textContent =
      `Se detectaron ${clips.length} animaciones para exportar a ${formatLabel}. Elige cuáles incluir:`;
  }

  listEl.innerHTML = '';
  const checkboxes = [];
  clips.forEach((clip) => {
    const owner = getClipOwner(clip);
    const kfCount = getClipKeyframeTimes(clip).length;
    const dur = clip.duration > 0 ? clip.duration.toFixed(1) : '0.0';

    const row = document.createElement('label');
    row.className = 'export-anim-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    checkboxes.push({ cb, clip });

    const info = document.createElement('div');
    info.className = 'export-anim-item-info';
    const nameEl = document.createElement('span');
    nameEl.className = 'export-anim-item-name';
    nameEl.textContent = clip.name || 'Animación';
    const subEl = document.createElement('span');
    subEl.className = 'export-anim-item-sub';
    subEl.textContent = `${owner?.name || 'Escena'} · ${dur}s · ${kfCount} keyframes · ${clip.tracks.length} pistas`;

    info.append(nameEl, subEl);
    row.append(cb, info);
    listEl.appendChild(row);
  });

  modal.hidden = false;

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.hidden = true;
      dom.btnExportAnimAll?.removeEventListener('click', onAll);
      dom.btnExportAnimNone?.removeEventListener('click', onNone);
      dom.btnExportAnimConfirm?.removeEventListener('click', onConfirm);
      dom.btnExportAnimCancel?.removeEventListener('click', onCancel);
      dom.btnExportAnimX?.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
    };
    const onAll = () => checkboxes.forEach(({ cb }) => { cb.checked = true; });
    const onNone = () => checkboxes.forEach(({ cb }) => { cb.checked = false; });
    const onConfirm = () => {
      const selected = checkboxes.filter(({ cb }) => cb.checked).map(({ clip }) => clip);
      cleanup();
      resolve(selected);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onBackdrop = (e) => {
      if (e.target === modal) onCancel();
    };

    dom.btnExportAnimAll?.addEventListener('click', onAll);
    dom.btnExportAnimNone?.addEventListener('click', onNone);
    dom.btnExportAnimConfirm?.addEventListener('click', onConfirm);
    dom.btnExportAnimCancel?.addEventListener('click', onCancel);
    dom.btnExportAnimX?.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

export async function exportSceneFormat(kind) {
  const info = buildExportTarget();
  if (!info) return;

  history._hooks.ensureRigWeightPaintRestored?.();
  try {
    if (kind === 'glb' || kind === 'gltf') {
      const detectedAnims = collectExportableAnimations(info.target);
      let animationsToExport = [];
      if (detectedAnims.length > 0) {
        const picked = await promptExportAnimationSelection(detectedAnims, `.${kind}`);
        if (picked === null) {
          setStatus('Exportación cancelada.');
          return;
        }
        animationsToExport = picked;
      }

      try {
        setStatus(`Generando archivo .${kind}...`);
        const { GLTFExporter } = await loadGLTFExporter();
        const exporter = new GLTFExporter();
        if (kind === 'glb') {
          const buffer = await exporter.parse(info.target, { binary: true, animations: animationsToExport });
          downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), `${info.baseName}.glb`);
          setStatus(
            `Exportado: ${info.baseName}.glb (${(buffer.byteLength / 1024).toFixed(1)} KB${
              animationsToExport.length ? ` · ${animationsToExport.length} anim.` : ''
            })`
          );
        } else {
          const json = await exporter.parse(info.target, { binary: false, animations: animationsToExport });
          const text = JSON.stringify(json, null, 2);
          downloadBlob(new Blob([text], { type: 'model/gltf+json' }), `${info.baseName}.gltf`);
          setStatus(
            `Exportado: ${info.baseName}.gltf (${(text.length / 1024).toFixed(1)} KB${
              animationsToExport.length ? ` · ${animationsToExport.length} anim.` : ''
            })`
          );
        }
      } catch (err) {
        setStatus(`Error al exportar ${kind.toUpperCase()}: ${err.message}`, true);
      }
      return;
    }

    if (kind === 'obj') {
      try {
        const { OBJExporter } = await loadOBJExporter();
        const exporter = new OBJExporter();
        const { obj } = exporter.parseWithMaterials(info.target, { mtlFilename: `${info.baseName}.mtl` });
        downloadBlob(new Blob([obj], { type: 'text/plain;charset=utf-8' }), `${info.baseName}.obj`);
        setStatus(`Exportado: ${info.baseName}.obj (${(obj.length / 1024).toFixed(1)} KB)`);
      } catch (err) {
        setStatus(`Error al exportar OBJ: ${err.message}`, true);
      }
      return;
    }

    if (kind === 'mtl') {
      try {
        const { OBJExporter } = await loadOBJExporter();
        const exporter = new OBJExporter();
        const { mtl } = exporter.parseWithMaterials(info.target, { mtlFilename: `${info.baseName}.mtl` });
        if (!mtl) {
          setStatus('La selección no tiene materiales para exportar .mtl.', true);
          return;
        }
        downloadBlob(new Blob([mtl], { type: 'text/plain;charset=utf-8' }), `${info.baseName}.mtl`);
        setStatus(`Exportado: ${info.baseName}.mtl`);
      } catch (err) {
        setStatus(`Error al exportar MTL: ${err.message}`, true);
      }
    }
  } finally {
    history._hooks.syncRigUI?.();
  }
}

export async function handleModelFiles(fileList) {
  let files = Array.from(fileList || []);
  if (!files.length) return;

  const zipFiles = files.filter((f) => /\.zip$/i.test(f.name));
  if (zipFiles.length) {
    setStatus(`Descomprimiendo ${zipFiles[0].name}...`);
    try {
      const { ZipLoader } = await loadZipLoader();
      const zipLoader = new ZipLoader();
      const nonZip = files.filter((f) => !/\.zip$/i.test(f.name));
      for (const zf of zipFiles) {
        const extracted = await zipLoader.loadFile(zf);
        nonZip.push(...extracted);
      }
      files = nonZip;
    } catch (err) {
      setStatus(`Error al descomprimir ZIP: ${err.message}`, true);
      return;
    }
  }

  const mainModel =
    files.find((f) => /\.(glb|gltf)$/i.test(f.name)) ||
    files.find((f) => /\.obj$/i.test(f.name)) ||
    null;
  const ktx2File = !mainModel ? files.find((f) => /\.ktx2$/i.test(f.name)) : null;

  if (!mainModel && ktx2File) {
    setStatus(`Transcodificando textura KTX2: ${ktx2File.name}...`);
    try {
      if (!viewport.ktx2Loader) {
        const { KTX2Loader } = await loadKTX2Loader();
        viewport.ktx2Loader = new KTX2Loader().detectSupport(viewport.renderer);
      }
      const tex = await viewport.ktx2Loader.loadFile(ktx2File, { colorSpace: 'srgb' });
      const mat = sceneStore.selected?.getPrimaryMaterial?.() || null;
      const dims = `${tex.width || 0}x${tex.height || 0}`;
      const fmtTag = tex.compressed ? 'comprimida GPU' : 'RGBA32';
      if (mat) {
        mat.map = tex;
        if (mat.color) mat.color.set(0xffffff);
        syncSelectedUI();
        setStatus(`Textura KTX2 aplicada a ${sceneStore.selected.name || 'selección'}: ${ktx2File.name} (${dims}, ${fmtTag})`);
      } else {
        const mesh = addPrimitive('box', {
          name: ktx2File.name.replace(/\.ktx2$/i, '') || 'Cubo KTX2',
          color: 0xffffff,
          shininess: 24,
          recordHistory: true,
        });
        mesh.material.map = tex;
        syncSelectedUI();
        focusOnObject(mesh);
        setStatus(`Cubo creado con textura KTX2: ${ktx2File.name} (${dims}, ${fmtTag})`);
      }
    } catch (err) {
      setStatus(`Error al cargar KTX2: ${err.message}`, true);
    }
    return;
  }

  if (!mainModel) {
    setStatus('Selecciona un archivo .glb, .gltf, .obj, .zip o .ktx2.', true);
    return;
  }

  const extras = files.filter((f) => f !== mainModel);
  setStatus(`Cargando ${mainModel.name}...`);

  try {
    let root = null;
    let clips = [];

    if (/\.obj$/i.test(mainModel.name)) {
      const { OBJLoader } = await loadOBJLoader();
      const loader = new OBJLoader();
      root = await loader.loadFile(mainModel, extras);
    } else {
      const { GLTFLoader } = await loadGLTFLoader();
      const loader = new GLTFLoader({
        ktx2Loader: viewport.ktx2Loader,
        dracoLoader: viewport.dracoLoader,
        renderer: viewport.renderer,
      });
      const gltf = await loader.loadFile(mainModel, extras);
      if (loader.ktx2Loader && !viewport.ktx2Loader) viewport.ktx2Loader = loader.ktx2Loader;
      if (loader.dracoLoader && !viewport.dracoLoader) viewport.dracoLoader = loader.dracoLoader;
      root = gltf.scene;
      clips = gltf.animations || [];
    }

    if (!root) throw new Error('El archivo no contiene geometría.');

    autoScaleObject(root, { targetSize: 2.8, centerXZ: true, alignBottom: true });
    root.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = true;
        node.receiveShadow = true;
      }
    });

    const beforeSceneMeta = history.captureSceneMeta();
    const { cmd } = registerUserObject(root, mainModel.name, true);
    selectObject(root);
    focusOnObject(root);

    if (clips.length) {
      const { AnimationMixer } = await loadAnimation();
      sceneStore.mixer = new AnimationMixer(root);
      sceneStore.animations = clips;
      viewport.picker.setMixer(sceneStore.mixer);
      registerImportedClips(root, clips);
      if (dom.animSelect) dom.animSelect.innerHTML = '';
      clips.forEach((clip, idx) => {
        const opt = document.createElement('option');
        opt.value = String(idx);
        opt.textContent = clip.name || `Clip ${idx + 1}`;
        dom.animSelect?.appendChild(opt);
      });
      playAnimationClip(0);
      if (dom.animGroup) dom.animGroup.hidden = false;
    } else {
      sceneStore.mixer = null;
      sceneStore.animations = [];
      sceneStore.activeAction = null;
      sceneStore.activeClipIndex = 0;
      if (viewport.picker) viewport.picker.setMixer(null);
      if (dom.animSelect) dom.animSelect.innerHTML = '';
      if (dom.animGroup) dom.animGroup.hidden = true;
    }

    if (cmd) {
      cmd.beforeSceneMeta = beforeSceneMeta;
      cmd.afterSceneMeta = history.captureSceneMeta();
    }

    setStatus(`Modelo cargado: ${mainModel.name}${clips.length ? ` (${clips.length} animaciones)` : ''}`);
  } catch (err) {
    setStatus(`Error al cargar: ${err.message}`, true);
  }
}
