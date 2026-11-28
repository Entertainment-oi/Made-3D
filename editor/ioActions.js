import {
  Texture,
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
  recordAutoKeyframeIfNeeded,
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

function inspectExportCapabilities(target) {
  let hasRigging = false;
  let hasTextures = false;
  if (target && typeof target.traverse === 'function') {
    target.traverse((node) => {
      if (node.isSkinnedMesh || node.isBone || node.skeleton) {
        hasRigging = true;
      }
      if (node.isMesh) {
        const mat = node.material;
        const hasMaps = Boolean(
          mat &&
            (mat.map ||
              mat.normalMap ||
              mat.roughnessMap ||
              mat.metalnessMap ||
              mat.aoMap ||
              mat.emissiveMap)
        );
        const hasColors = Boolean(node.geometry?.attributes?.color);
        const hasUV = Boolean(node.geometry?.attributes?.uv);
        if (hasMaps || hasColors || hasUV) hasTextures = true;
      }
    });
  }
  const clips = collectExportableAnimations(target);
  return { hasRigging, hasTextures, clips };
}

function promptExportOptions(kind) {
  const modal = dom.exportOptionsModal;
  if (!modal) {
    const info = buildExportTarget();
    if (!info) return Promise.resolve(null);
    return Promise.resolve({
      target: info.target,
      baseName: info.baseName,
      includeRigging: true,
      includeTextures: true,
      animations: collectExportableAnimations(info.target),
    });
  }

  const objects = sceneStore.userObjects || [];
  const supportsRigging = kind === 'glb' || kind === 'gltf' || kind === 'obj';
  const supportsAnimations = kind === 'glb' || kind === 'gltf';

  if (dom.exportOptTitle) {
    dom.exportOptTitle.textContent = `Exportar a .${kind}`;
  }

  // Poblar selector de objeto específico
  if (dom.exportOptTarget) {
    dom.exportOptTarget.innerHTML = '';
    let defaultIdx = 0;
    objects.forEach((obj, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      opt.textContent = obj.name || `Objeto ${idx + 1}`;
      if (obj === sceneStore.selected) defaultIdx = idx;
      dom.exportOptTarget.appendChild(opt);
    });
    if (objects.length) {
      dom.exportOptTarget.value = String(defaultIdx);
    }
  }

  if (dom.exportOptScope) {
    const initScope = dom.exportScope?.value === 'selected' && sceneStore.selected ? 'selected' : 'scene';
    dom.exportOptScope.value = initScope;
  }

  let clipCheckboxes = [];

  const resolveCurrentTarget = () => {
    const scope = dom.exportOptScope?.value === 'selected' ? 'selected' : 'scene';
    if (scope === 'selected') {
      const idx = Math.max(0, Math.min(objects.length - 1, Number(dom.exportOptTarget?.value) || 0));
      const obj = objects[idx] || sceneStore.selected;
      if (obj) {
        return { target: obj, baseName: (obj.name || 'modelo').replace(/\s+/g, '_') };
      }
    }
    return { target: viewport.scene, baseName: 'escena_made3d' };
  };

  const renderAnimChecklist = (clips) => {
    const listEl = dom.exportOptAnimList;
    if (!listEl) return;
    listEl.innerHTML = '';
    clipCheckboxes = [];
    if (dom.exportAnimDesc) {
      dom.exportAnimDesc.textContent = `Clips detectados (${clips.length}):`;
    }
    clips.forEach((clip) => {
      const owner = getClipOwner(clip);
      const kfCount = getClipKeyframeTimes(clip).length;
      const dur = clip.duration > 0 ? clip.duration.toFixed(1) : '0.0';

      const row = document.createElement('label');
      row.className = 'export-anim-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      clipCheckboxes.push({ cb, clip });

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
  };

  const syncModalToTarget = () => {
    const scope = dom.exportOptScope?.value === 'selected' ? 'selected' : 'scene';
    if (dom.exportOptTargetRow) {
      dom.exportOptTargetRow.hidden = scope !== 'selected';
    }
    const { target } = resolveCurrentTarget();
    const { hasRigging, hasTextures, clips } = inspectExportCapabilities(target);

    if (dom.rowExportOptRigging) {
      dom.rowExportOptRigging.hidden = !supportsRigging;
      const labelSpan = dom.rowExportOptRigging.querySelector('span');
      if (labelSpan) {
        labelSpan.textContent = hasRigging
          ? kind === 'obj'
            ? 'Rigging y pose actual'
            : 'Rigging y esqueleto'
          : 'Rigging y esqueleto (no detectado)';
      }
    }
    if (dom.exportOptRigging) {
      dom.exportOptRigging.checked = supportsRigging && hasRigging;
      dom.exportOptRigging.disabled = !supportsRigging || !hasRigging;
    }

    if (dom.rowExportOptTextures) {
      dom.rowExportOptTextures.hidden = false;
      const labelSpan = dom.rowExportOptTextures.querySelector('span');
      if (labelSpan) {
        labelSpan.textContent =
          kind === 'mtl'
            ? 'Texturas y materiales (.mtl)'
            : hasTextures
            ? 'Texturas, pintura y UVs'
            : 'Texturas, pintura y UVs (color base)';
      }
    }
    if (dom.exportOptTextures) {
      dom.exportOptTextures.checked = true;
      dom.exportOptTextures.disabled = kind === 'mtl';
    }

    if (dom.rowExportOptAnimations) {
      dom.rowExportOptAnimations.hidden = !supportsAnimations;
      const labelSpan = dom.rowExportOptAnimations.querySelector('span');
      if (labelSpan) {
        labelSpan.textContent = clips.length
          ? `Animaciones (${clips.length})`
          : 'Animaciones (no detectadas)';
      }
    }
    if (dom.exportOptAnimations) {
      dom.exportOptAnimations.checked = supportsAnimations && clips.length > 0;
      dom.exportOptAnimations.disabled = !supportsAnimations || clips.length === 0;
    }

    renderAnimChecklist(clips);
    if (dom.exportOptAnimWrap) {
      dom.exportOptAnimWrap.hidden = !(
        supportsAnimations &&
        clips.length > 0 &&
        dom.exportOptAnimations?.checked
      );
    }
  };

  syncModalToTarget();
  modal.hidden = false;

  return new Promise((resolve) => {
    const cleanup = () => {
      modal.hidden = true;
      dom.exportOptScope?.removeEventListener('change', syncModalToTarget);
      dom.exportOptTarget?.removeEventListener('change', syncModalToTarget);
      dom.exportOptAnimations?.removeEventListener('change', onAnimToggle);
      dom.btnExportOptAnimAll?.removeEventListener('click', onAll);
      dom.btnExportOptAnimNone?.removeEventListener('click', onNone);
      dom.btnExportOptConfirm?.removeEventListener('click', onConfirm);
      dom.btnExportOptCancel?.removeEventListener('click', onCancel);
      dom.btnExportOptX?.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
    };
    const onAnimToggle = () => {
      if (dom.exportOptAnimWrap) {
        dom.exportOptAnimWrap.hidden = !(
          supportsAnimations &&
          clipCheckboxes.length > 0 &&
          dom.exportOptAnimations?.checked
        );
      }
    };
    const onAll = () => clipCheckboxes.forEach(({ cb }) => { cb.checked = true; });
    const onNone = () => clipCheckboxes.forEach(({ cb }) => { cb.checked = false; });
    const onConfirm = () => {
      const { target, baseName } = resolveCurrentTarget();
      if (dom.exportScope && dom.exportOptScope) {
        dom.exportScope.value = dom.exportOptScope.value;
      }
      const includeRigging = supportsRigging && Boolean(dom.exportOptRigging?.checked);
      const includeTextures = dom.exportOptTextures ? Boolean(dom.exportOptTextures.checked) : true;
      const includeAnimations = supportsAnimations && Boolean(dom.exportOptAnimations?.checked);
      const animations = includeAnimations
        ? clipCheckboxes.filter(({ cb }) => cb.checked).map(({ clip }) => clip)
        : [];
      cleanup();
      resolve({
        target,
        baseName,
        includeRigging,
        includeTextures,
        animations,
      });
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onBackdrop = (e) => {
      if (e.target === modal) onCancel();
    };

    dom.exportOptScope?.addEventListener('change', syncModalToTarget);
    dom.exportOptTarget?.addEventListener('change', syncModalToTarget);
    dom.exportOptAnimations?.addEventListener('change', onAnimToggle);
    dom.btnExportOptAnimAll?.addEventListener('click', onAll);
    dom.btnExportOptAnimNone?.addEventListener('click', onNone);
    dom.btnExportOptConfirm?.addEventListener('click', onConfirm);
    dom.btnExportOptCancel?.addEventListener('click', onCancel);
    dom.btnExportOptX?.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

export async function exportSceneFormat(kind) {
  const exportables = viewport.scene.getExportables({ recursive: false });
  if (!sceneStore.userObjects.length || !exportables.length) {
    setStatus('No hay objetos exportables en la escena.', true);
    return;
  }

  const options = await promptExportOptions(kind);
  if (!options) {
    setStatus('Exportación cancelada.');
    return;
  }

  const { target, baseName, includeRigging, includeTextures, animations } = options;

  history._hooks.ensureRigWeightPaintRestored?.();
  try {
    if (kind === 'glb' || kind === 'gltf') {
      try {
        setStatus(`Generando archivo .${kind}...`);
        const { GLTFExporter } = await loadGLTFExporter();
        const exporter = new GLTFExporter();
        const parseOpts = {
          binary: kind === 'glb',
          animations,
          includeRigging,
          includeTextures,
        };
        if (kind === 'glb') {
          const buffer = await exporter.parse(target, parseOpts);
          downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), `${baseName}.glb`);
          setStatus(
            `Exportado: ${baseName}.glb (${(buffer.byteLength / 1024).toFixed(1)} KB${
              animations.length ? ` · ${animations.length} anim.` : ''
            })`
          );
        } else {
          const json = await exporter.parse(target, parseOpts);
          const text = JSON.stringify(json, null, 2);
          downloadBlob(new Blob([text], { type: 'model/gltf+json' }), `${baseName}.gltf`);
          setStatus(
            `Exportado: ${baseName}.gltf (${(text.length / 1024).toFixed(1)} KB${
              animations.length ? ` · ${animations.length} anim.` : ''
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
        const { obj } = exporter.parseWithMaterials(target, {
          mtlFilename: `${baseName}.mtl`,
          includeRigging,
          includeTextures,
        });
        downloadBlob(new Blob([obj], { type: 'text/plain;charset=utf-8' }), `${baseName}.obj`);
        setStatus(`Exportado: ${baseName}.obj (${(obj.length / 1024).toFixed(1)} KB)`);
      } catch (err) {
        setStatus(`Error al exportar OBJ: ${err.message}`, true);
      }
      return;
    }

    if (kind === 'mtl') {
      try {
        const { OBJExporter } = await loadOBJExporter();
        const exporter = new OBJExporter();
        const { mtl } = exporter.parseWithMaterials(target, {
          mtlFilename: `${baseName}.mtl`,
          includeRigging,
          includeTextures: true,
        });
        if (!mtl) {
          setStatus('La selección no tiene materiales para exportar .mtl.', true);
          return;
        }
        downloadBlob(new Blob([mtl], { type: 'text/plain;charset=utf-8' }), `${baseName}.mtl`);
        setStatus(`Exportado: ${baseName}.mtl`);
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

  const imgFile = !mainModel && !ktx2File ? files.find((f) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) : null;

  if (!mainModel && ktx2File) {
    setStatus(`Transcodificando textura KTX2: ${ktx2File.name}...`);
    try {
      if (!viewport.ktx2Loader) {
        const { KTX2Loader } = await loadKTX2Loader();
        viewport.ktx2Loader = new KTX2Loader().detectSupport(viewport.renderer);
      }
      const tex = await viewport.ktx2Loader.loadFile(ktx2File, { colorSpace: 'srgb' });
      tex.name = ktx2File.name;
      tex.userData = { customName: ktx2File.name };
      const mats = sceneStore.selected?.collectMaterials?.() || [];
      const dims = `${tex.width || 0}x${tex.height || 0}`;
      const fmtTag = tex.compressed ? 'comprimida GPU' : 'RGBA32';
      if (mats.length) {
        for (const mat of mats) {
          if ('map' in mat) mat.map = tex;
        }
        syncSelectedUI();
        recordAutoKeyframeIfNeeded([sceneStore.selected], { properties: ['material.map'] });
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

  if (!mainModel && imgFile) {
    setStatus(`Cargando imagen como textura: ${imgFile.name}...`);
    try {
      const tex = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            const t = new Texture(img, {
              width: img.naturalWidth || img.width,
              height: img.naturalHeight || img.height,
              colorSpace: 'srgb',
              name: imgFile.name,
              userData: { customName: imgFile.name },
            });
            t.needsUpdate = true;
            resolve(t);
          };
          img.onerror = () => reject(new Error(`No se pudo decodificar la imagen "${imgFile.name}".`));
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error(`Error leyendo "${imgFile.name}".`));
        reader.readAsDataURL(imgFile);
      });

      const mats = sceneStore.selected?.collectMaterials?.() || [];
      if (mats.length) {
        for (const mat of mats) {
          if ('map' in mat) mat.map = tex;
        }
        syncSelectedUI();
        recordAutoKeyframeIfNeeded([sceneStore.selected], { properties: ['material.map'] });
        setStatus(`Textura "${imgFile.name}" aplicada a ${sceneStore.selected.name || 'selección'}.`);
      } else {
        const mesh = addPrimitive('box', {
          name: imgFile.name.replace(/\.[^.]+$/, '') || 'Cubo textura',
          color: 0xffffff,
          shininess: 24,
          recordHistory: true,
        });
        mesh.material.map = tex;
        syncSelectedUI();
        focusOnObject(mesh);
        setStatus(`Cubo creado con textura "${imgFile.name}".`);
      }
    } catch (err) {
      setStatus(err.message || `Error al cargar imagen "${imgFile.name}".`, true);
    }
    return;
  }

  if (!mainModel) {
    setStatus('Selecciona un archivo .glb, .gltf, .obj, .zip, .ktx2 o imagen (.png, .jpg, .webp).', true);
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
