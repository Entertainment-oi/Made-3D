import { Quat } from '../math/Quat.js';
import { Vec3 } from '../math/Vec3.js';

const _evalV3 = new Vec3();
const _evalQuat = new Quat();

function evalInterp(interpolation, t) {
  if (interpolation === 'smooth') return t * t * (3 - 2 * t);
  if (interpolation === 'easeIn') return t * t;
  if (interpolation === 'easeOut') return 1 - (1 - t) * (1 - t);
  return t;
}

function roundKeyframeTime(t) {
  return Math.round(Math.max(0, Number(t) || 0) * 1000) / 1000;
}

function readObjectPropertyValues(obj, property) {
  if (!obj) return null;
  if (property === 'quaternion') {
    return [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w];
  }
  const prop = property === 'weights' ? 'morphTargetInfluences' : property;
  const val = obj[prop];
  if (!val) return null;
  if (Array.isArray(val) || ArrayBuffer.isView(val)) {
    return Array.from(val);
  }
  if (val.x !== undefined && val.y !== undefined && val.z !== undefined) {
    return [val.x, val.y, val.z];
  }
  return null;
}

function trackMatchesProperty(track, property) {
  if (!property) return true;
  const list = Array.isArray(property) ? property : [property];
  const trProp = track.property || (track.name && track.name.includes('.') ? track.name.split('.').pop() : '');
  for (const p of list) {
    if (trProp === p || (track.name && track.name.endsWith(`.${p}`))) return true;
  }
  return false;
}

function isDescendantOrSelfNode(node, ancestor) {
  let cur = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Pista de keyframes: una propiedad de un objeto que cambia a lo largo del tiempo.
 *
 * `name` dice a qué se aplica: 'Hombro.position' (objeto por nombre + propiedad) o, si quieres
 * atar el pista a un objeto concreto, `track.target = hueso` y `track.property = 'position'`.
 *
 * Propiedades admitidas: 'position', 'scale' (Vec3), 'quaternion' (Quat) y 'rotation' (Euler).
 * Interpolación: 'linear' (por defecto), 'smooth', 'easeIn', 'easeOut' o 'step'.
 */
export class KeyframeTrack {
  constructor(name, times, values, interpolation = 'linear') {
    this.name = name;
    this.times = times instanceof Float32Array ? times : Float32Array.from(times);
    this.values = values instanceof Float32Array ? values : Float32Array.from(values);
    this.interpolation = interpolation;
    this.valueSize = 3;
    this.target = null;      // Object3D (opcional): si se pone, gana sobre el nombre
    this.property = null;    // 'position' | 'quaternion' | 'scale' | 'rotation'
  }
  get duration() { return this.times.length ? this.times[this.times.length - 1] : 0; }
  get count() { return this.times.length; }

  // Intervalo del keyframe: devuelve { i, t } con t entre 0 y 1 hacia el siguiente.
  _search(time) {
    const T = this.times, n = T.length;
    if (!n) return { i: 0, t: 0 };
    if (time <= T[0]) return { i: 0, t: 0 };
    if (time >= T[n - 1]) return { i: n - 1, t: 0 };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (T[mid] <= time) lo = mid; else hi = mid;
    }
    const span = T[hi] - T[lo];
    return { i: lo, t: span > 0 ? (time - T[lo]) / span : 0 };
  }

  // Valor de la pista en `time` (sin aplicar).
  evaluate(time, target) {
    if (!this.times.length) return target;
    const { i, t } = this._search(time);
    const s = this.valueSize, v = this.values;
    if (this.interpolation === 'step' || i >= this.times.length - 1) {
      target.set(v[i * s], v[i * s + 1], v[i * s + 2]);
      return target;
    }
    const k = evalInterp(this.interpolation, t);
    const a = i * s, b = (i + 1) * s, w = 1 - k;
    target.set(v[a] * w + v[b] * k, v[a + 1] * w + v[b + 1] * k, v[a + 2] * w + v[b + 2] * k);
    return target;
  }

  // Keyframe más cercano a `time` (para el picking y las depuraciones).
  nearestKeyframe(time) {
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.times.length; i++) {
      const d = Math.abs(this.times[i] - time);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  getKeyframeIndexAt(time, eps = 0.035) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.times.length; i++) {
      const d = Math.abs(this.times[i] - time);
      if (d <= eps && d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  hasKeyframeAt(time, eps = 0.035) {
    return this.getKeyframeIndexAt(time, eps) >= 0;
  }

  getKeyframeValueAt(time, eps = 0.035) {
    const idx = this.getKeyframeIndexAt(time, eps);
    if (idx < 0) return null;
    const s = this.valueSize;
    return {
      index: idx,
      time: this.times[idx],
      values: Array.from(this.values.slice(idx * s, idx * s + s)),
    };
  }

  setKeyframe(time, valArr, { mergeEps = 0.035 } = {}) {
    const t = roundKeyframeTime(time);
    const s = this.valueSize;
    const times = Array.from(this.times);
    const values = Array.from(this.values);

    const existingIdx = this.getKeyframeIndexAt(t, mergeEps);
    if (existingIdx >= 0) {
      times[existingIdx] = t;
      for (let j = 0; j < s; j++) values[existingIdx * s + j] = valArr[j] ?? 0;
      this.times = Float32Array.from(times);
      this.values = Float32Array.from(values);
      return { index: existingIdx, time: t, replaced: true };
    }

    let insertIdx = times.length;
    for (let i = 0; i < times.length; i++) {
      if (times[i] > t) {
        insertIdx = i;
        break;
      }
    }
    const cleanVals = new Array(s);
    for (let j = 0; j < s; j++) cleanVals[j] = valArr[j] ?? 0;
    times.splice(insertIdx, 0, t);
    values.splice(insertIdx * s, 0, ...cleanVals);
    this.times = Float32Array.from(times);
    this.values = Float32Array.from(values);
    return { index: insertIdx, time: t, replaced: false };
  }

  removeKeyframeAt(time, eps = 0.035) {
    const s = this.valueSize;
    const times = Array.from(this.times);
    const values = Array.from(this.values);
    let removed = false;
    for (let i = times.length - 1; i >= 0; i--) {
      if (Math.abs(times[i] - time) <= eps) {
        times.splice(i, 1);
        values.splice(i * s, s);
        removed = true;
      }
    }
    if (removed) {
      this.times = Float32Array.from(times);
      this.values = Float32Array.from(values);
    }
    return removed;
  }

  moveKeyframe(fromTime, toTime, { eps = 0.035, mergeEps = 0.025, merge = false } = {}) {
    const idx = this.getKeyframeIndexAt(fromTime, eps);
    if (idx < 0) return false;
    const s = this.valueSize;
    const destTime = roundKeyframeTime(toTime);
    const movedVals = Array.from(this.values.slice(idx * s, idx * s + s));

    const entries = [];
    for (let i = 0; i < this.times.length; i++) {
      if (i === idx) continue;
      const kt = this.times[i];
      if (merge && Math.abs(kt - destTime) <= mergeEps) continue;
      entries.push({ t: kt, v: Array.from(this.values.slice(i * s, i * s + s)), isMoved: false });
    }
    entries.push({ t: destTime, v: movedVals, isMoved: true });
    entries.sort((a, b) => (a.t !== b.t ? a.t - b.t : (a.isMoved ? 1 : -1)));

    this.times = Float32Array.from(entries.map((e) => e.t));
    this.values = Float32Array.from(entries.flatMap((e) => e.v));
    return true;
  }

  captureSnapshot() {
    return {
      trackRef: this,
      name: this.name,
      property: this.property || null,
      target: this.target || null,
      valueSize: this.valueSize,
      interpolation: this.interpolation || 'linear',
      times: Float32Array.from(this.times),
      values: Float32Array.from(this.values),
    };
  }

  restoreSnapshot(snap) {
    if (!snap) return this;
    this.name = snap.name ?? this.name;
    this.property = snap.property ?? null;
    this.target = snap.target ?? null;
    this.valueSize = snap.valueSize ?? this.valueSize;
    this.interpolation = snap.interpolation || 'linear';
    this.times = Float32Array.from(snap.times || []);
    this.values = Float32Array.from(snap.values || []);
    return this;
  }

  clone() {
    const c = new KeyframeTrack(this.name, Float32Array.from(this.times), Float32Array.from(this.values), this.interpolation);
    c.valueSize = this.valueSize;
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

// Pista de Vector3: posición, escala o rotación (Euler).
export class VectorKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, interpolation = 'linear') {
    super(name, times, values, interpolation);
    this.valueSize = 3;
  }
  clone() {
    const c = new VectorKeyframeTrack(this.name, Float32Array.from(this.times), Float32Array.from(this.values), this.interpolation);
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

// Pista de cuaternión (rotación): interpola con slerp.
export class QuaternionKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, interpolation = 'linear') {
    super(name, times, values, interpolation);
    this.valueSize = 4;
  }
  evaluate(time, target) {
    if (!this.times.length) return target;
    const { i, t } = this._search(time);
    const s = 4, v = this.values;
    const a = i * s, b = (i + 1) * s;
    const q = _q.set(v[a], v[a + 1], v[a + 2], v[a + 3]);
    if (this.interpolation === 'step' || i >= this.times.length - 1) return target.set(q.x, q.y, q.z, q.w);
    const q2 = _q2.set(v[b], v[b + 1], v[b + 2], v[b + 3]);
    const k = evalInterp(this.interpolation, t);
    target.set(q.x, q.y, q.z, q.w);
    return target.slerp(q2, k);
  }
  clone() {
    const c = new QuaternionKeyframeTrack(this.name, Float32Array.from(this.times), Float32Array.from(this.values), this.interpolation);
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

const _q = new Quat(), _q2 = new Quat();

// Pista de arreglo numérico (p. ej. pesos de morph targets).
export class NumberArrayKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, valueSize = 1, interpolation = 'linear') {
    super(name, times, values, interpolation);
    this.valueSize = Math.max(1, valueSize | 0);
  }
  evaluate(time, target = []) {
    const s = this.valueSize;
    if (!this.times.length) {
      for (let j = 0; j < s; j++) target[j] = 0;
      return target;
    }
    const { i, t } = this._search(time);
    const v = this.values;
    if (this.interpolation === 'step' || i >= this.times.length - 1) {
      const a = i * s;
      for (let j = 0; j < s; j++) target[j] = v[a + j] ?? 0;
      return target;
    }
    const k = evalInterp(this.interpolation, t);
    const a = i * s, b = (i + 1) * s, w = 1 - k;
    for (let j = 0; j < s; j++) target[j] = (v[a + j] ?? 0) * w + (v[b + j] ?? 0) * k;
    return target;
  }
  clone() {
    const c = new NumberArrayKeyframeTrack(
      this.name,
      Float32Array.from(this.times),
      Float32Array.from(this.values),
      this.valueSize,
      this.interpolation
    );
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

/**
 * Clip de animación: un grupo de pistas con una duración común.
 *
 *   const clip = new AnimationClip('saludo');
 *   clip.addTrack(new VectorKeyframeTrack('Hombro.position', [0, 1, 2], [0,0,0, 0,.5,0, 0,0,0]));
 */
export class AnimationClip {
  constructor(name = '', duration = -1) {
    this.name = name;
    this.tracks = [];
    this.duration = duration;
  }

  static trackMatchesTarget(track, target, fallbackRoot = null) {
    if (!target) return true;
    if (!track) return false;
    if (track.target) return track.target === target;
    const resolved = AnimationClip.resolveTrackTarget(track, fallbackRoot);
    return Boolean(resolved && resolved.object === target);
  }

  static resolveTrackTarget(track, fallbackRoot = null) {
    if (!track) return null;
    if (track.target) {
      const idx = track.name ? track.name.lastIndexOf('.') : -1;
      const property = track.property || (idx >= 0 ? track.name.slice(idx + 1) : 'position');
      return { object: track.target, property };
    }
    const name = track.name || '';
    const idx = name.lastIndexOf('.');
    const property = track.property || (idx >= 0 ? name.slice(idx + 1) : 'position');
    const nodePath = idx >= 0 ? name.slice(0, idx) : name;
    const root = fallbackRoot;
    let obj = null;
    if (!nodePath) {
      obj = root;
    } else if (root) {
      if (nodePath.indexOf('/') >= 0) {
        let cur = root;
        for (const part of nodePath.split('/')) {
          if (!cur || !cur.children) { cur = null; break; }
          cur = cur.children.find((c) => c.name === part) || null;
        }
        obj = cur;
      } else if (root.name === nodePath) {
        obj = root;
      } else if (typeof root.getObjectByName === 'function') {
        obj = root.getObjectByName(nodePath);
      }
    }
    return obj ? { object: obj, property } : null;
  }

  static detectChangedProperties(beforeState, afterState, eps = 1e-5) {
    if (!beforeState || !afterState) return ['position', 'quaternion', 'scale'];
    const changed = [];
    const bp = beforeState.p || beforeState.position;
    const ap = afterState.p || afterState.position;
    if (bp && ap && bp.distanceTo(ap) > eps) changed.push('position');

    const bq = beforeState.q || beforeState.quaternion;
    const aq = afterState.q || afterState.quaternion;
    if (bq && aq && Math.abs(bq.dot(aq)) < 1 - eps * 0.1) changed.push('quaternion');

    const bs = beforeState.s || beforeState.scale;
    const as = afterState.s || afterState.scale;
    if (bs && as && bs.distanceTo(as) > eps) changed.push('scale');
    return changed;
  }

  static getMaxDuration(clips = []) {
    let maxDur = 0;
    for (const clip of clips) {
      if (!clip || !clip.tracks) continue;
      const hasKf = clip.tracks.some((tr) => tr.times && tr.times.length > 0);
      if (!hasKf) continue;
      const d = clip.getEffectiveDuration();
      if (d > maxDur) maxDur = d;
    }
    return maxDur;
  }

  addTrack(track) {
    this.tracks.push(track);
    if (track.duration > this.duration) this.duration = track.duration;
    return this;
  }

  getTrack(name) {
    for (const t of this.tracks) if (t.name === name) return t;
    return null;
  }

  getEffectiveDuration() {
    let d = this.duration > 0 ? this.duration : 0;
    for (const tr of this.tracks) {
      if (tr.times && tr.times.length && tr.times[tr.times.length - 1] > d) {
        d = tr.times[tr.times.length - 1];
      }
    }
    return d;
  }

  getInterpolation() {
    if (!this.tracks.length) return 'linear';
    return this.tracks[0].interpolation || 'linear';
  }

  setInterpolation(interpolation = 'linear') {
    for (const tr of this.tracks) {
      tr.interpolation = interpolation;
    }
    return this;
  }

  getTrackByTarget(obj, property) {
    if (!obj) return null;
    const baseName = `${obj.name || `Obj_${obj.id}`}.${property}`;
    return (
      this.tracks.find(
        (tr) => (tr.target === obj && tr.property === property) || tr.name === baseName
      ) || null
    );
  }

  getOrCreateTrack(obj, property, valueSize = null) {
    let track = this.getTrackByTarget(obj, property);
    if (!track) {
      const baseName = `${obj.name || `Obj_${obj.id}`}.${property}`;
      const defaultInterp = this.getInterpolation();
      const isWeightProp = property === 'weights' || property === 'morphTargetInfluences';
      if (property === 'quaternion') {
        track = new QuaternionKeyframeTrack(baseName, [], [], defaultInterp);
      } else if (isWeightProp || (valueSize != null && valueSize > 0 && valueSize !== 3)) {
        const size = Math.max(1, (valueSize | 0) || obj?.morphTargetInfluences?.length || 1);
        track = new NumberArrayKeyframeTrack(baseName, [], [], size, defaultInterp);
      } else {
        track = new VectorKeyframeTrack(baseName, [], [], defaultInterp);
      }
      track.target = obj;
      track.property = property;
      this.tracks.push(track);
    }
    return track;
  }

  hasTracksForTarget(target, owner = null) {
    if (!target || !this.tracks.length) return false;
    return this.tracks.some(
      (tr) => tr.times && tr.times.length > 0 && AnimationClip.trackMatchesTarget(tr, target, owner)
    );
  }

  getKeyframeTimes(propertyOrOpts = null) {
    let property = propertyOrOpts;
    let target = null;
    let owner = null;
    if (propertyOrOpts && typeof propertyOrOpts === 'object' && !Array.isArray(propertyOrOpts)) {
      property = propertyOrOpts.properties ?? propertyOrOpts.property ?? null;
      target = propertyOrOpts.target ?? null;
      owner = propertyOrOpts.owner ?? null;
    }
    const raw = [];
    for (const tr of this.tracks) {
      if (!trackMatchesProperty(tr, property)) continue;
      if (target && !AnimationClip.trackMatchesTarget(tr, target, owner)) continue;
      for (let i = 0; i < tr.times.length; i++) {
        raw.push(tr.times[i]);
      }
    }
    raw.sort((a, b) => a - b);
    const uniq = [];
    for (const t of raw) {
      if (!uniq.length || Math.abs(t - uniq[uniq.length - 1]) > 0.008) {
        uniq.push(t);
      }
    }
    return uniq;
  }

  hasKeyframeAt(time, { properties = null, target = null, owner = null, eps = 0.035 } = {}) {
    for (const tr of this.tracks) {
      if (!trackMatchesProperty(tr, properties)) continue;
      if (target && !AnimationClip.trackMatchesTarget(tr, target, owner)) continue;
      if (tr.hasKeyframeAt(time, eps)) return true;
    }
    return false;
  }

  setObjectKeyframe(obj, time, properties = ['position', 'quaternion', 'scale'], { mergeEps = 0.035, autoExpand = true } = {}) {
    if (!obj) return false;
    const props = Array.isArray(properties) && properties.length ? properties : ['position', 'quaternion', 'scale'];
    const t = roundKeyframeTime(time);
    if (autoExpand && t > this.duration) {
      this.duration = Math.max(0.2, Number((t + 0.25).toFixed(2)));
    }
    let updated = false;
    for (const prop of props) {
      const valArr = readObjectPropertyValues(obj, prop);
      if (!valArr || !valArr.length) continue;
      const tr = this.getOrCreateTrack(obj, prop, valArr.length);
      tr.setKeyframe(t, valArr, { mergeEps });
      updated = true;
    }
    return updated;
  }

  removeKeyframeAt(time, { properties = null, target = null, owner = null, eps = 0.035 } = {}) {
    let anyRemoved = false;
    for (const tr of this.tracks) {
      if (!trackMatchesProperty(tr, properties)) continue;
      if (target && !AnimationClip.trackMatchesTarget(tr, target, owner)) continue;
      if (tr.removeKeyframeAt(time, eps)) anyRemoved = true;
    }
    return anyRemoved;
  }

  captureSnapshot() {
    return {
      name: this.name,
      duration: this.duration,
      tracks: this.tracks.map((tr) => tr.captureSnapshot()),
    };
  }

  restoreSnapshot(snap) {
    if (!snap) return this;
    this.name = snap.name;
    this.duration = snap.duration;
    const nextTracks = [];
    for (const item of snap.tracks || []) {
      const tr = item.trackRef;
      if (tr && typeof tr.restoreSnapshot === 'function') {
        tr.restoreSnapshot(item);
        nextTracks.push(tr);
      }
    }
    this.tracks = nextTracks;
    return this;
  }

  previewMoveKeyframe(beforeSnapshot, fromTime, toTime, { properties = null, target = null, owner = null, eps = 0.035 } = {}) {
    if (beforeSnapshot) this.restoreSnapshot(beforeSnapshot);
    let moved = false;
    for (const tr of this.tracks) {
      if (!trackMatchesProperty(tr, properties)) continue;
      if (target && !AnimationClip.trackMatchesTarget(tr, target, owner)) continue;
      if (tr.moveKeyframe(fromTime, toTime, { eps, merge: false })) moved = true;
    }
    return moved;
  }

  commitMoveKeyframe(beforeSnapshot, fromTime, toTime, { properties = null, target = null, owner = null, eps = 0.035, mergeEps = 0.025 } = {}) {
    if (beforeSnapshot) this.restoreSnapshot(beforeSnapshot);
    let moved = false;
    for (const tr of this.tracks) {
      if (!trackMatchesProperty(tr, properties)) continue;
      if (target && !AnimationClip.trackMatchesTarget(tr, target, owner)) continue;
      if (tr.moveKeyframe(fromTime, toTime, { eps, mergeEps, merge: true })) moved = true;
    }
    return moved;
  }

  extractKeyframeData(time, { properties = null, target = null, owner = null, eps = 0.035 } = {}) {
    const outProps = {};
    let count = 0;
    for (const tr of this.tracks) {
      if (!trackMatchesProperty(tr, properties)) continue;
      if (target && !AnimationClip.trackMatchesTarget(tr, target, owner)) continue;
      const kf = tr.getKeyframeValueAt(time, eps);
      if (!kf) continue;
      const prop = tr.property || (tr.name && tr.name.includes('.') ? tr.name.split('.').pop() : null);
      if (!prop) continue;
      outProps[prop] = {
        values: kf.values.slice(),
        valueSize: tr.valueSize,
        interpolation: tr.interpolation || 'linear',
      };
      count++;
    }
    if (!count) return null;
    return {
      sourceClipName: this.name || '',
      sourceTime: roundKeyframeTime(time),
      properties: outProps,
    };
  }

  applyKeyframeData(obj, data, time, { mergeEps = 0.035, autoExpand = true } = {}) {
    if (!obj || !data || !data.properties) return [];
    const t = roundKeyframeTime(time);
    if (autoExpand && t > this.duration) {
      this.duration = Math.max(0.2, Number((t + 0.25).toFixed(2)));
    }
    const pasted = [];
    for (const [prop, entry] of Object.entries(data.properties)) {
      if (!entry || !Array.isArray(entry.values) || !entry.values.length) continue;
      const tr = this.getOrCreateTrack(obj, prop, entry.valueSize || entry.values.length);
      if (entry.interpolation && !tr.times.length) {
        tr.interpolation = entry.interpolation;
      }
      tr.setKeyframe(t, entry.values, { mergeEps });
      pasted.push(prop);
    }
    if (pasted.length) {
      this.evaluateAt(t, obj);
    }
    return pasted;
  }

  evaluateAt(time, fallbackRoot = null) {
    if (!this.tracks.length) return [];
    const dur = Math.max(0, this.duration || 0);
    const localTime = dur > 0 ? Math.max(0, Math.min(dur, time)) : Math.max(0, time);
    const updated = new Set();

    for (const track of this.tracks) {
      if (!track.times || !track.times.length) continue;
      const resolved = AnimationClip.resolveTrackTarget(track, fallbackRoot);
      if (!resolved || !resolved.object) continue;
      const { object, property } = resolved;
      const prop = property === 'weights' ? 'morphTargetInfluences' : property;
      const targetVal = object[prop];
      if (!targetVal) continue;

      if (Array.isArray(targetVal) || ArrayBuffer.isView(targetVal)) {
        const arr = track.evaluate(localTime, []);
        for (let i = 0; i < targetVal.length && i < arr.length; i++) {
          targetVal[i] = arr[i];
        }
      } else if (prop === 'quaternion' && track.valueSize === 4) {
        track.evaluate(localTime, _evalQuat);
        targetVal.set(_evalQuat.x, _evalQuat.y, _evalQuat.z, _evalQuat.w);
      } else {
        track.evaluate(localTime, _evalV3);
        targetVal.set(_evalV3.x, _evalV3.y, _evalV3.z);
      }
      object.updateMatrixWorld();
      updated.add(object);
    }
    return Array.from(updated);
  }

  targetsObject(target, owner = null) {
    if (!target || !this.tracks.length) return false;
    const hasKeys = this.tracks.some((tr) => tr.times && tr.times.length > 0);
    if (!hasKeys) return false;
    if (owner && isDescendantOrSelfNode(owner, target)) return true;
    return this.tracks.some((tr) => {
      if (tr.target && isDescendantOrSelfNode(tr.target, target)) return true;
      if (tr.name && target.getObjectByName) {
        const nodeName = tr.name.split('.')[0];
        if (nodeName && (target.name === nodeName || target.getObjectByName(nodeName))) return true;
      }
      return false;
    });
  }
}

