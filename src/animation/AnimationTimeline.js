import { AnimationClip } from './AnimationClip.js';

function isDescendantOrSelf(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Línea de tiempo de animación por objeto/hueso y clips de escena sin dependencias del DOM.
 * Gestiona clips por objeto, aislamiento por hueso/nodo seleccionado, reproducción,
 * auto-keyframe, snapping y copiar/pegar/mover keyframes.
 */
export class AnimationTimeline {
  constructor(opts = {}) {
    this.objectClips = new WeakMap();
    this.activeClipByObject = new WeakMap();
    this.clipOwners = new WeakMap();
    this.allClips = [];
    this.currentClip = null;
    this.currentTime = 0;
    this.defaultDuration = opts.defaultDuration ?? 3.0;
    this.playing = false;
    this.speed = opts.speed ?? 1;
    this.loopMode = opts.loopMode || 'repeat';
    this.autoKeyframe = opts.autoKeyframe !== undefined ? Boolean(opts.autoKeyframe) : true;
    this.snap = opts.snap !== undefined ? Boolean(opts.snap) : true;
    this.snapStep = opts.snapStep ?? 0.05;
    this.keyframeHitEps = opts.keyframeHitEps ?? 0.035;
    this.copiedKeyframe = null;
    this._pingPongDir = 1;
  }

  snapTime(t) {
    const clamped = Math.max(0, Number(t) || 0);
    if (!this.snap) return Math.round(clamped * 1000) / 1000;
    const step = this.snapStep || 0.05;
    return Math.round(Math.round(clamped / step) * step * 1000) / 1000;
  }

  _getClipListRef(obj) {
    if (!obj) return [];
    let list = this.objectClips.get(obj);
    if (!list) {
      list = [];
      this.objectClips.set(obj, list);
    }
    return list;
  }

  getObjectClips(obj) {
    return obj ? this._getClipListRef(obj).slice() : [];
  }

  getClipOwner(clip) {
    return clip ? this.clipOwners.get(clip) || null : null;
  }

  getActiveClipForObject(obj) {
    if (!obj) return null;
    const active = this.activeClipByObject.get(obj);
    if (active && this.allClips.includes(active)) return active;
    const list = this._getClipListRef(obj);
    return list[0] || null;
  }

  getAllClips(extraClips = null) {
    const out = [];
    const seen = new Set();
    for (const clip of this.allClips) {
      if (clip && !seen.has(clip)) {
        seen.add(clip);
        out.push(clip);
      }
    }
    if (Array.isArray(extraClips)) {
      for (const clip of extraClips) {
        if (clip && !seen.has(clip)) {
          seen.add(clip);
          out.push(clip);
        }
      }
    }
    return out;
  }

  /**
   * Resuelve el clip efectivo y el objetivo de filtrado para un nodo u objeto seleccionado.
   * Si el objeto seleccionado tiene sus propios clips, usa su clip activo.
   * Si un ancestro (p. ej. un rig GLB) posee un clip que contiene pistas dirigidas específicamente
   * al nodo seleccionado, permite editar esas pistas aisladas a ese nodo; en cualquier otro caso
   * devuelve `clip: null` para no mostrar ni editar keyframes de otros huesos/objetos.
   */
  resolveClipContext(selected = null) {
    if (!selected) {
      const clip = this.currentClip && this.allClips.includes(this.currentClip) ? this.currentClip : null;
      return {
        clip,
        owner: this.getClipOwner(clip),
        filterTarget: null,
      };
    }

    if (this.currentClip && this.getClipOwner(this.currentClip) === selected && this.allClips.includes(this.currentClip)) {
      return {
        clip: this.currentClip,
        owner: selected,
        filterTarget: selected,
      };
    }

    const ownActive = this.getActiveClipForObject(selected);
    if (ownActive) {
      return {
        clip: ownActive,
        owner: selected,
        filterTarget: selected,
      };
    }

    let cur = selected.parent;
    while (cur) {
      const ancestorActive = this.getActiveClipForObject(cur);
      if (ancestorActive && ancestorActive.hasTracksForTarget(selected, cur)) {
        return {
          clip: ancestorActive,
          owner: cur,
          filterTarget: selected,
        };
      }
      cur = cur.parent;
    }

    return {
      clip: null,
      owner: null,
      filterTarget: selected,
    };
  }

  syncForSelection(selected = null) {
    const ctx = this.resolveClipContext(selected);
    this.currentClip = ctx.clip;
    return ctx;
  }

  getActiveDuration() {
    if (this.currentClip && this.currentClip.duration > 0) {
      return this.currentClip.duration;
    }
    return this.defaultDuration || 3.0;
  }

  createClip(obj, name = '', { duration = this.defaultDuration || 3.0, select = true } = {}) {
    const owner = obj || null;
    const list = owner ? this._getClipListRef(owner) : [];
    const nextIndex = (owner ? list.length : this.allClips.length) + 1;
    const clipName = String(name || '').trim() || `Animación ${nextIndex}`;
    const clip = new AnimationClip(clipName, Math.max(0.2, Number(duration) || 3.0));

    if (owner) {
      list.push(clip);
      this.activeClipByObject.set(owner, clip);
      this.clipOwners.set(clip, owner);
    }
    this.allClips.push(clip);
    if (select) {
      this.currentClip = clip;
      this.currentTime = Math.min(this.currentTime, clip.duration);
    }
    return clip;
  }

  selectClip(clip, { roots = [], fallbackRoot = null } = {}) {
    if (!clip) {
      this.currentClip = null;
      return null;
    }
    this.currentClip = clip;
    const owner = this.getClipOwner(clip);
    if (owner) {
      this.activeClipByObject.set(owner, clip);
    }
    const dur = Math.max(0.2, clip.duration > 0 ? clip.duration : (this.defaultDuration || 3.0));
    if (this.currentTime > dur) this.currentTime = dur;
    this.evaluateAt(this.currentTime, roots, fallbackRoot);
    return clip;
  }

  renameClip(clip, newName) {
    if (!clip) return false;
    const trimmed = String(newName || '').trim();
    if (!trimmed) return false;
    clip.name = trimmed;
    return true;
  }

  deleteClip(clip, selected = null) {
    if (!clip) return false;
    const owner = this.clipOwners.get(clip);
    if (owner) {
      const list = this._getClipListRef(owner).filter((c) => c !== clip);
      this.objectClips.set(owner, list);
      if (this.activeClipByObject.get(owner) === clip) {
        if (list.length) this.activeClipByObject.set(owner, list[0]);
        else this.activeClipByObject.delete(owner);
      }
    }
    this.allClips = this.allClips.filter((c) => c !== clip);
    this.clipOwners.delete(clip);

    if (this.currentClip === clip) {
      this.currentClip = selected
        ? this.resolveClipContext(selected).clip
        : (this.allClips[0] || null);
    }
    return true;
  }

  cleanupClipsForObject(obj, selected = null) {
    if (!obj) return 0;
    const toDelete = [];
    for (const clip of this.allClips) {
      const owner = this.clipOwners.get(clip);
      if (owner && isDescendantOrSelf(owner, obj)) {
        toDelete.push(clip);
      }
    }
    for (const clip of toDelete) {
      this.deleteClip(clip, selected);
    }
    return toDelete.length;
  }

  clearAllClips() {
    this.objectClips = new WeakMap();
    this.activeClipByObject = new WeakMap();
    this.clipOwners = new WeakMap();
    this.allClips = [];
    this.currentClip = null;
    this.currentTime = 0;
    this.playing = false;
    this._pingPongDir = 1;
  }

  registerImportedClips(root, clips = []) {
    if (!root || !Array.isArray(clips) || !clips.length) return [];
    const list = this._getClipListRef(root);
    const registered = [];
    for (const clip of clips) {
      if (!clip) continue;
      if (!(clip.duration > 0)) clip.duration = 3.0;
      if (!list.includes(clip)) list.push(clip);
      if (!this.allClips.includes(clip)) this.allClips.push(clip);
      this.clipOwners.set(clip, root);
      registered.push(clip);
    }
    if (!this.activeClipByObject.get(root) && list[0]) {
      this.activeClipByObject.set(root, list[0]);
    }
    if (!this.currentClip && list[0]) {
      this.currentClip = list[0];
    }
    return registered;
  }

  captureStateSnapshot() {
    return {
      allClips: this.allClips.slice(),
      owners: this.allClips.map((c) => [c, this.clipOwners.get(c) || null]),
      currentClip: this.currentClip,
    };
  }

  restoreStateSnapshot(snap, selected = null) {
    if (!snap) return;
    this.objectClips = new WeakMap();
    this.activeClipByObject = new WeakMap();
    this.clipOwners = new WeakMap();
    this.allClips = (snap.allClips || []).slice();
    for (const [clip, owner] of snap.owners || []) {
      if (!clip) continue;
      if (owner) {
        this.clipOwners.set(clip, owner);
        const list = this._getClipListRef(owner);
        if (!list.includes(clip)) list.push(clip);
        if (!this.activeClipByObject.get(owner)) {
          this.activeClipByObject.set(owner, clip);
        }
      }
    }
    if (selected) {
      const ctx = this.resolveClipContext(selected);
      this.currentClip = ctx.clip;
    } else {
      this.currentClip =
        (snap.currentClip && this.allClips.includes(snap.currentClip) ? snap.currentClip : null) ||
        this.allClips[0] ||
        null;
    }
  }

  collectEvaluableClips(roots = [], extraClips = []) {
    const activeClips = [];
    const seen = new Set();

    for (const root of roots || []) {
      if (!root) continue;
      const clip = this.getActiveClipForObject(root);
      if (clip && !seen.has(clip)) {
        seen.add(clip);
        activeClips.push(clip);
      }
      if (typeof root.traverse === 'function') {
        root.traverse((child) => {
          if (child === root) return;
          const c = this.getActiveClipForObject(child);
          if (c && !seen.has(c)) {
            seen.add(c);
            activeClips.push(c);
          }
        });
      }
    }

    if (this.currentClip && !seen.has(this.currentClip)) {
      seen.add(this.currentClip);
      activeClips.push(this.currentClip);
    }
    for (const c of extraClips || []) {
      if (c && !seen.has(c)) {
        seen.add(c);
        activeClips.push(c);
      }
    }
    return activeClips;
  }

  evaluateClipAt(clip, time, fallbackRoot = null) {
    if (!clip || !clip.tracks.length) return [];
    const owner = this.getClipOwner(clip) || fallbackRoot;
    return clip.evaluateAt(time, owner);
  }

  evaluateAt(time, roots = [], fallbackRoot = null) {
    const clips = this.collectEvaluableClips(roots);
    const updated = new Set();
    for (const clip of clips) {
      for (const obj of this.evaluateClipAt(clip, time, fallbackRoot)) {
        updated.add(obj);
      }
    }
    return Array.from(updated);
  }

  getMaxDuration(roots = [], extraClips = []) {
    const clips = this.collectEvaluableClips(roots, extraClips);
    const maxDur = AnimationClip.getMaxDuration(clips);
    const spd = this.speed > 0 ? this.speed : 1;
    return maxDur > 0 ? maxDur / spd : 0;
  }

  getPlaybackDuration(roots = [], extraClips = []) {
    if (this.currentClip && this.currentClip.duration > 0) {
      return this.currentClip.duration;
    }
    return this.getMaxDuration(roots, extraClips) || 3.0;
  }

  hasAnyKeyframes(roots = [], extraClips = []) {
    const clips = this.collectEvaluableClips(roots, extraClips);
    return clips.some((c) => c.tracks.some((tr) => tr.times && tr.times.length > 0));
  }

  setPlaying(play, roots = [], extraClips = []) {
    const next = Boolean(play);
    if (next) {
      if (!this.hasAnyKeyframes(roots, extraClips)) {
        this.playing = false;
        return { playing: false, empty: true };
      }
      const dur = Math.max(0.2, this.getPlaybackDuration(roots, extraClips));
      if (this.loopMode === 'once' && this.currentTime >= dur - 0.005) {
        this.currentTime = 0;
      }
      this._pingPongDir = 1;
    }
    this.playing = next;
    return { playing: this.playing, empty: false };
  }

  setCurrentTime(t, roots = [], fallbackRoot = null) {
    this.currentTime = Math.max(0, Number(t) || 0);
    return this.evaluateAt(this.currentTime, roots, fallbackRoot);
  }

  step(dt, roots = [], extraClips = [], fallbackRoot = null) {
    if (!this.playing) return { playing: false, currentTime: this.currentTime, updatedObjects: [] };
    const dur = Math.max(0.2, this.getPlaybackDuration(roots, extraClips));
    const delta = dt * (this.speed || 1);
    let t = this.currentTime;

    if (this.loopMode === 'pingpong') {
      t += delta * this._pingPongDir;
      if (t >= dur) {
        t = dur - Math.max(0, t - dur);
        this._pingPongDir = -1;
      } else if (t <= 0) {
        t = Math.abs(t);
        this._pingPongDir = 1;
      }
    } else if (this.loopMode === 'once') {
      t += delta;
      if (t >= dur) {
        t = dur;
        this.playing = false;
      }
    } else {
      t = (t + delta) % dur;
    }

    this.currentTime = Math.max(0, Math.min(dur, t));
    const updatedObjects = this.evaluateAt(this.currentTime, roots, fallbackRoot);
    return {
      playing: this.playing,
      currentTime: this.currentTime,
      updatedObjects,
    };
  }

  getKeyframeTimesForSelection(selected = null, property = null) {
    const ctx = this.resolveClipContext(selected);
    if (!ctx.clip) return [];
    return ctx.clip.getKeyframeTimes({
      property,
      target: ctx.filterTarget,
      owner: ctx.owner,
    });
  }

  hasKeyframeAtSelection(selected = null, time = this.currentTime, properties = null, eps = this.keyframeHitEps) {
    const ctx = this.resolveClipContext(selected);
    if (!ctx.clip) return false;
    return ctx.clip.hasKeyframeAt(time, {
      properties,
      target: ctx.filterTarget,
      owner: ctx.owner,
      eps,
    });
  }

  insertKeyframe(obj, time = this.currentTime, { properties = null, mergeEps = this.keyframeHitEps } = {}) {
    if (!obj) return { ok: false, reason: 'no-target' };
    const ctx = this.resolveClipContext(obj);
    let clip = ctx.clip;
    const createdNewClip = !clip;
    const beforeState = createdNewClip ? this.captureStateSnapshot() : null;
    if (!clip) {
      const baseDur = this.defaultDuration || 3.0;
      clip = this.createClip(obj, '', { duration: Math.max(baseDur, Math.ceil(time + 0.5)), select: true });
    } else {
      this.currentClip = clip;
    }

    const props =
      Array.isArray(properties) && properties.length
        ? properties
        : ['position', 'quaternion', 'scale'];

    const t = this.snapTime(time);
    const beforeClip = clip.captureSnapshot();
    const updated = clip.setObjectKeyframe(obj, t, props, { mergeEps, autoExpand: true });
    if (!updated) {
      if (createdNewClip && beforeState) this.restoreStateSnapshot(beforeState, obj);
      return { ok: false, reason: 'no-properties' };
    }

    return {
      ok: true,
      clip,
      owner: this.getClipOwner(clip) || obj,
      target: obj,
      time: t,
      properties: props,
      createdNewClip,
      beforeState,
      afterState: createdNewClip ? this.captureStateSnapshot() : null,
      beforeClip,
      afterClip: clip.captureSnapshot(),
    };
  }

  removeKeyframe(selected = null, time = this.currentTime, { properties = null, eps = this.keyframeHitEps, roots = [], fallbackRoot = null } = {}) {
    const ctx = this.resolveClipContext(selected);
    if (!ctx.clip) return { ok: false };
    const beforeClip = ctx.clip.captureSnapshot();
    const removed = ctx.clip.removeKeyframeAt(time, {
      properties,
      target: ctx.filterTarget,
      owner: ctx.owner,
      eps,
    });
    if (!removed) return { ok: false };

    this.evaluateAt(this.currentTime, roots, fallbackRoot);
    return {
      ok: true,
      clip: ctx.clip,
      owner: ctx.owner,
      beforeClip,
      afterClip: ctx.clip.captureSnapshot(),
    };
  }

  recordAutoKeyframe(targets = [], { beforeList = null, afterList = null, properties = null, toolProperties = null, time = this.currentTime } = {}) {
    if (!this.autoKeyframe || this.playing) return [];
    const list = Array.isArray(targets) ? targets : [];
    const results = [];

    list.forEach((obj, idx) => {
      if (!obj) return;
      let props = properties;
      if (!props && Array.isArray(beforeList) && Array.isArray(afterList) && beforeList[idx] && afterList[idx]) {
        const changed = AnimationClip.detectChangedProperties(beforeList[idx], afterList[idx]);
        if (!changed.length) return;
        if (Array.isArray(toolProperties) && toolProperties.length === 1) {
          props = changed.includes(toolProperties[0]) ? toolProperties : changed;
        } else {
          props = changed;
        }
      } else if (!props) {
        props = (Array.isArray(toolProperties) && toolProperties.length ? toolProperties : null) || ['position', 'quaternion', 'scale'];
      }
      if (!props || !props.length) return;
      const res = this.insertKeyframe(obj, time, { properties: props });
      if (res.ok) results.push(res);
    });

    return results;
  }

  copyKeyframe(selected = null, time = this.currentTime, properties = null, eps = this.keyframeHitEps) {
    const ctx = this.resolveClipContext(selected);
    if (!ctx.clip) return null;
    const data = ctx.clip.extractKeyframeData(time, {
      properties,
      target: ctx.filterTarget,
      owner: ctx.owner,
      eps,
    });
    if (!data) return null;
    this.copiedKeyframe = data;
    return data;
  }

  pasteKeyframe(targetObj = null, time = this.currentTime, { roots = [], fallbackRoot = null, mergeEps = this.keyframeHitEps } = {}) {
    const data = this.copiedKeyframe;
    if (!data) return { ok: false, reason: 'empty-clipboard' };
    const obj = targetObj || this.getClipOwner(this.currentClip);
    if (!obj) return { ok: false, reason: 'no-target' };

    const ctx = this.resolveClipContext(obj);
    let clip = ctx.clip;
    const createdNewClip = !clip;
    const beforeState = createdNewClip ? this.captureStateSnapshot() : null;
    if (!clip) {
      clip = this.createClip(obj, '', { duration: Math.max(this.defaultDuration || 3.0, Math.ceil(time + 0.5)), select: true });
    } else {
      this.currentClip = clip;
    }

    const t = this.snapTime(time);
    const beforeClip = clip.captureSnapshot();
    const pasted = clip.applyKeyframeData(obj, data, t, { mergeEps, autoExpand: true });
    if (!pasted.length) {
      if (createdNewClip && beforeState) this.restoreStateSnapshot(beforeState, obj);
      return { ok: false, reason: 'nothing-pasted' };
    }

    this.evaluateAt(this.currentTime, roots, fallbackRoot);
    return {
      ok: true,
      clip,
      owner: this.getClipOwner(clip) || obj,
      time: t,
      pasted,
      createdNewClip,
      beforeState,
      afterState: createdNewClip ? this.captureStateSnapshot() : null,
      beforeClip,
      afterClip: clip.captureSnapshot(),
    };
  }
}
