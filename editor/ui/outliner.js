import { dom, setStatus } from '../dom.js';
import { viewport, sceneStore, cameraView, isDescendantOrSelf } from '../store.js';
import { history } from '../history.js';
import { selectObject } from '../viewport.js';
import { enterCameraView, exitCameraView } from '../cameraView.js';
import { clearUserObjects, deleteSelected } from '../sceneActions.js';
import { syncAnimationUI } from '../animationController.js';
import { closeAllPopovers } from './popovers.js';
import { syncSelectedUI } from './objectInspector.js';

function makeEyeSvg(visible) {
  return visible
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.77 21.77 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a21.8 21.8 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
}

const PENCIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
const TRASH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`;

function startInlineRename(obj, nameSpan) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'object-rename-input';
  input.value = obj.name || `Objeto #${obj.id}`;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      const next = input.value.trim();
      if (next) obj.name = next;
    }
    syncSelectedUI();
    syncAnimationUI();
    renderObjectList();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
}

export function renderObjectList() {
  if (!dom.objectList) return;
  dom.objectList.innerHTML = '';
  if (!sceneStore.userObjects.length) {
    const li = document.createElement('li');
    li.className = 'helper-text';
    li.textContent = 'No hay objetos en la escena.';
    dom.objectList.appendChild(li);
    return;
  }

  const isMulti = sceneStore.selectedList.length > 1 || Boolean(viewport.gizmo?.multiSelectMode);

  for (const obj of sceneStore.userObjects) {
    const isSel = obj === sceneStore.selected || sceneStore.selectedList.includes(obj);
    const li = document.createElement('li');
    li.className =
      'object-item' +
      (isSel ? (isMulti ? ' is-multi' : ' is-selected') : '') +
      (!obj.visible ? ' is-hidden-obj' : '');

    const mainBtn = document.createElement('div');
    mainBtn.className = 'object-item-main';

    const dot = document.createElement('span');
    dot.className =
      'object-item-dot' +
      (obj.isLight ? ' is-light' : obj.isCamera ? ' is-camera' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'object-item-name';
    nameSpan.textContent = obj.name || `Objeto #${obj.id}`;

    mainBtn.append(dot, nameSpan);
    mainBtn.addEventListener('click', () => selectObject(obj));

    const meta = document.createElement('span');
    meta.className = 'object-item-meta';

    if (obj.isCamera) {
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      const isViewing = cameraView.activeSceneCam === obj;
      jumpBtn.className = 'cam-jump-btn' + (isViewing ? ' is-active' : '');
      jumpBtn.textContent = isViewing ? 'Activa' : 'Ver';
      jumpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cameraView.activeSceneCam === obj) exitCameraView();
        else {
          selectObject(obj);
          enterCameraView(obj);
          closeAllPopovers();
        }
      });
      meta.appendChild(jumpBtn);
    }

    const eyeBtn = document.createElement('button');
    eyeBtn.type = 'button';
    eyeBtn.className = 'outliner-icon-btn';
    eyeBtn.title = obj.visible ? 'Ocultar' : 'Mostrar';
    eyeBtn.innerHTML = makeEyeSvg(obj.visible !== false);
    eyeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      obj.visible = !obj.visible;
      renderObjectList();
    });

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'outliner-icon-btn';
    renameBtn.title = 'Renombrar';
    renameBtn.innerHTML = PENCIL_SVG;
    renameBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startInlineRename(obj, nameSpan);
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'outliner-icon-btn is-danger';
    delBtn.title = 'Eliminar';
    delBtn.innerHTML = TRASH_SVG;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSelected(obj);
    });

    meta.append(eyeBtn, renameBtn, delBtn);
    li.append(mainBtn, meta);
    dom.objectList.appendChild(li);

    const parts = obj.collectMeshes ? obj.collectMeshes() : [];
    for (const part of parts) {
      const pli = document.createElement('li');
      pli.className =
        'object-item is-child' +
        (part === sceneStore.selected ? ' is-selected' : '') +
        (!part.visible ? ' is-hidden-obj' : '');
      const pName = document.createElement('span');
      pName.className = 'object-item-name';
      pName.textContent = '↳ ' + (part.name || `Parte #${part.id}`);
      const pEye = document.createElement('button');
      pEye.type = 'button';
      pEye.className = 'outliner-icon-btn';
      pEye.innerHTML = makeEyeSvg(part.visible !== false);
      pEye.addEventListener('click', (e) => {
        e.stopPropagation();
        part.visible = !part.visible;
        renderObjectList();
      });
      pli.append(pName, pEye);
      pli.addEventListener('click', () => selectObject(part));
      dom.objectList.appendChild(pli);
    }

    if (sceneStore.selected && sceneStore.selected.isBone && isDescendantOrSelf(sceneStore.selected, obj)) {
      const bli = document.createElement('li');
      bli.className = 'object-item is-child is-selected';
      const bName = document.createElement('span');
      bName.className = 'object-item-name';
      bName.textContent = '↳ ' + (sceneStore.selected.name || `Hueso #${sceneStore.selected.id}`);
      bli.append(bName);
      dom.objectList.appendChild(bli);
    }
  }
}

export function bindOutlinerActions() {
  dom.btnClearScene?.addEventListener('click', () => {
    if (!sceneStore.userObjects.length) return;
    const prevSelected = sceneStore.selected;
    const removals = sceneStore.userObjects.map((u) => history.buildRemovalRecord(u));
    const sceneMeta = history.captureSceneMeta();
    clearUserObjects();
    const afterSceneMeta = history.captureSceneMeta();
    history.push({ type: 'delete', removals, prevSelected, sceneMeta, afterSceneMeta });
    setStatus('Escena limpiada (Ctrl+Z para deshacer).');
  });
}
