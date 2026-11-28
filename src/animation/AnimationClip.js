import { Quat } from '../math/Quat.js';
import { Vec3 } from '../math/Vec3.js';
import { Color } from '../math/Color.js';

const _evalV3 = new Vec3();
const _evalQuat = new Quat();
const _evalColor = new Color();

const NESTED_PROP_PREFIXES = ['.material.', '.shadow.'];

const BOOLEAN_PROPS = new Set([
  'visible',
  'castShadow',
  'material.wireframe',
  'material.autoAnimate',
]);

const OBJECT_PROPS = new Set([
  'material.map',
  'material.normalMap',
  'material.roughnessMap',
  'material.metalnessMap',
  'material.aoMap',
  'material.emissiveMap',
  'material.metallicRoughnessMap',
  'material.matcap',
]);

const COLOR_PROPS = new Set([
  'color',
  'material.color',
  'material.emissive',
  'material.shadowColor',
  'material.shadowTintColor',
  'material.rimColor',
  'material.inkColor',
  'material.stripeColor',
  'material.edgeColor',
]);

const NUMBER_PROPS = new Set([
  'fov',
  'intensity',
  'distance',
  'decay',
  'angle',
  'penumbra',
  'shadow.radius',
  'material.opacity',
  'material.shininess',
  'material.roughness',
  'material.metalness',
  'material.normalScale',
  'material.aoMapIntensity',
  'material.envMapIntensity',
  'material.steps',
  'material.smoothness',
  'material.shadowTint',
  'material.rimPower',
  'material.rimStrength',
  'material.inkWidth',
  'material.fresnelPower',
  'material.scanlineDensity',
  'material.scanlineSpeed',
  'material.glitchStrength',
  'material.glossiness',
  'material.fresnelIntensity',
  'material.iridescence',
  'material.pulseSpeed',
  'material.progress',
  'material.speed',
  'material.edgeWidth',
  'material.noiseScale',
]);

function evalInterp(interpolation, t) {
  if (interpolation === 'smooth') return t * t * (3 - 2 * t);
  if (interpolation === 'easeIn') return t * t;
  if (interpolation === 'easeOut') return 1 - (1 - t) * (1 - t);
  return t;
}

function roundKeyframeTime(t) {
  return Math.round(Math.max(0, Number(t) || 0) * 1000) / 1000;
}

export function splitTrackNameAndProperty(name = '', explicitProperty = null) {
  const rawName = String(name || '');
  if (explicitProperty) {
    const suffix = `.${explicitProperty}`;
    if (rawName.endsWith(suffix)) {
      return {
        nodePath: rawName.slice(0, rawName.length - suffix.length),
        property: explicitProperty,
      };
    }
    const idx = rawName.lastIndexOf('.');
    return {
      nodePath: idx >= 0 ? rawName.slice(0, idx) : rawName,
      property: explicitProperty,
    };
  }

  for (const prefix of NESTED_PROP_PREFIXES) {
    const idx = rawName.lastIndexOf(prefix);
    if (idx >= 0) {
      return {
        nodePath: rawName.slice(0, idx),
        property: rawName.slice(idx + 1),
      };
    }
  }

  const idx = rawName.lastIndexOf('.');
  return {
    nodePath: idx >= 0 ? rawName.slice(0, idx) : rawName,
    property: idx >= 0 ? rawName.slice(idx + 1) : 'position',
  };
}

export function getAnimatedPropertyKind(property, valueSize = null, sampleValues = null) {
  if (property === 'quaternion') return 'quaternion';
  if (property === 'weights' || property === 'morphTargetInfluences') return 'numberArray';
  if (BOOLEAN_PROPS.has(property)) return 'boolean';
  if (OBJECT_PROPS.has(property)) return 'object';
  if (COLOR_PROPS.has(property)) return 'color';
  if (NUMBER_PROPS.has(property)) return 'number';
  if (Array.isArray(sampleValues) && sampleValues.length === 1) {
    const first = sampleValues[0];
    if (first === null || (typeof first === 'object' && first !== null)) return 'object';
    if (typeof first === 'boolean') return 'boolean';
  }
  if (valueSize === 1) return 'number';
  if (valueSize != null && valueSize > 0 && valueSize !== 3) return 'numberArray';
  return 'vector';
}

function getPrimaryMat(obj) {
  if (!obj) return null;
  if (typeof obj.getPrimaryMaterial === 'function') return obj.getPrimaryMaterial();
  return obj.material || null;
}

function getAllMats(obj) {
  if (!obj) return [];
  if (typeof obj.collectMaterials === 'function') return obj.collectMaterials();
  return obj.material ? [obj.material] : [];
}

export function readObjectPropertyValues(obj, property) {
  if (!obj) return null;
  if (property === 'quaternion') {
    return [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w];
  }
  if (property === 'visible') {
    return [obj.visible !== false ? 1 : 0];
  }
  if (property === 'castShadow') {
    const casting = typeof obj.hasShadowCaster === 'function' ? obj.hasShadowCaster() : Boolean(obj.castShadow);
    return [casting ? 1 : 0];
  }
  if (property === 'shadow.radius') {
    const r = obj.shadow?.radius;
    return typeof r === 'number' && Number.isFinite(r) ? [r] : null;
  }
  if (property.startsWith('material.')) {
    const slot = property.slice('material.'.length);
    const mat = getPrimaryMat(obj);
    if (!mat) return null;
    if (OBJECT_PROPS.has(property)) {
      return [mat[slot] ?? null];
    }
    if (slot === 'shininess') {
      const s = typeof mat.getShininess === 'function' ? mat.getShininess() : (mat.shininess ?? 0);
      return [Number(s) || 0];
    }
    if (slot === 'normalScale') {
      return [Number(mat.normalScale?.x ?? 1)];
    }
    const val = mat[slot];
    if (val === undefined) return null;
    if (typeof val === 'boolean') return [val ? 1 : 0];
    if (typeof val === 'number') return [Number.isFinite(val) ? val : 0];
    if (val && typeof val === 'object' && val.r !== undefined && val.g !== undefined && val.b !== undefined) {
      return [val.r, val.g, val.b];
    }
    return null;
  }

  const prop = property === 'weights' ? 'morphTargetInfluences' : property;
  const val = obj[prop];
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return [val ? 1 : 0];
  if (typeof val === 'number') return [Number.isFinite(val) ? val : 0];
  if (Array.isArray(val) || ArrayBuffer.isView(val)) {
    return Array.from(val);
  }
  if (val.r !== undefined && val.g !== undefined && val.b !== undefined) {
    return [val.r, val.g, val.b];
  }
  if (val.x !== undefined && val.y !== undefined && val.z !== undefined) {
    return [val.x, val.y, val.z];
  }
  return null;
}

export function applyAnimatedProperty(obj, property, evaluatedValue) {
  if (!obj) return false;
  if (property === 'visible') {
    obj.visible = Boolean(evaluatedValue);
    return true;
  }
  if (property === 'castShadow') {
    const next = Boolean(evaluatedValue);
    if (typeof obj.setCastShadowRecursive === 'function') obj.setCastShadowRecursive(next);
    else obj.castShadow = next;
    return true;
  }
  if (property === 'fov') {
    const nextFov = Number(evaluatedValue);
    if (!Number.isFinite(nextFov)) return false;
    obj.fov = nextFov;
    if (typeof obj.updateProjection === 'function') obj.updateProjection();
    if (Array.isArray(obj.children)) {
      for (const child of obj.children) {
        if (child && child.isCameraHelper && typeof child.update === 'function') {
          child.update();
        }
      }
    }
    return true;
  }
  if (property === 'shadow.radius') {
    const nextR = Number(evaluatedValue);
    if (!obj.shadow || !Number.isFinite(nextR)) return false;
    obj.shadow.radius = nextR;
    return true;
  }
  if (property.startsWith('material.')) {
    const slot = property.slice('material.'.length);
    const mats = getAllMats(obj);
    if (!mats.length) return false;
    let applied = false;
    for (const mat of mats) {
      if (!mat) continue;
      if (OBJECT_PROPS.has(property)) {
        if (slot in mat) {
          const tex = evaluatedValue || null;
          mat[slot] = tex;
          if (tex && slot !== 'map' && slot !== 'emissiveMap' && typeof mat.setHasPbr === 'function' && !mat.hasPbr) {
            mat.setHasPbr(true);
          }
          applied = true;
        }
        continue;
      }
      if (slot === 'opacity') {
        const op = Number(evaluatedValue);
        if (Number.isFinite(op)) {
          if (typeof mat.setOpacity === 'function') mat.setOpacity(op);
          else {
            mat.opacity = op;
            mat.transparent = op < 0.999;
          }
          applied = true;
        }
        continue;
      }
      if (slot === 'shininess') {
        const sh = Number(evaluatedValue);
        if (Number.isFinite(sh)) {
          if (typeof mat.setShininess === 'function') mat.setShininess(sh);
          else mat.shininess = sh;
          applied = true;
        }
        continue;
      }
      if (slot === 'normalScale') {
        const ns = Number(evaluatedValue);
        if (mat.normalScale && Number.isFinite(ns)) {
          mat.normalScale.set(ns, ns);
          applied = true;
        }
        continue;
      }
      if (slot === 'steps') {
        const st = Number(evaluatedValue);
        if ('steps' in mat && Number.isFinite(st)) {
          mat.steps = Math.max(1, Math.round(st));
          applied = true;
        }
        continue;
      }
      const cur = mat[slot];
      if (cur === undefined) continue;
      if (cur && typeof cur.set === 'function' && cur.r !== undefined && cur.g !== undefined && cur.b !== undefined) {
        if (evaluatedValue && evaluatedValue.r !== undefined) {
          cur.set(evaluatedValue.r, evaluatedValue.g, evaluatedValue.b);
        } else if (Array.isArray(evaluatedValue)) {
          cur.set(evaluatedValue[0] ?? 0, evaluatedValue[1] ?? 0, evaluatedValue[2] ?? 0);
        }
        applied = true;
      } else if (typeof cur === 'boolean') {
        mat[slot] = Boolean(evaluatedValue);
        applied = true;
      } else if (typeof cur === 'number') {
        const num = Number(evaluatedValue);
        if (Number.isFinite(num)) {
          mat[slot] = num;
          applied = true;
        }
      }
    }
    return applied;
  }

  const prop = property === 'weights' ? 'morphTargetInfluences' : property;
  const targetVal = obj[prop];
  if (targetVal === undefined || targetVal === null) return false;

  if (typeof targetVal === 'boolean') {
    obj[prop] = Boolean(evaluatedValue);
    return true;
  }
  if (typeof targetVal === 'number') {
    const num = Number(evaluatedValue);
    if (!Number.isFinite(num)) return false;
    obj[prop] = num;
    return true;
  }
  if (targetVal && typeof targetVal.set === 'function' && targetVal.r !== undefined && targetVal.g !== undefined && targetVal.b !== undefined) {
    if (evaluatedValue && evaluatedValue.r !== undefined) {
      targetVal.set(evaluatedValue.r, evaluatedValue.g, evaluatedValue.b);
    } else if (Array.isArray(evaluatedValue)) {
      targetVal.set(evaluatedValue[0] ?? 0, evaluatedValue[1] ?? 0, evaluatedValue[2] ?? 0);
    }
    return true;
  }
  return false;
}

function trackMatchesProperty(track, property) {
  if (!property) return true;
  const list = Array.isArray(property) ? property : [property];
  const { property: trProp } = splitTrackNameAndProperty(track.name, track.property);
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
 * Propiedades admitidas: 'position', 'scale', 'quaternion', 'rotation', 'visible', 'fov',
 * propiedades de luz ('intensity', 'color', ...) y de material ('material.color', 'material.opacity', 'material.map', ...).
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
    this.property = null;    // 'position' | 'quaternion' | 'scale' | 'rotation' | 'material.color' | ...
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

// Pista escalar numérica (p. ej. intensidad de luz, opacidad, brillo, FOV).
export class NumberKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, interpolation = 'linear') {
    super(name, times, values, interpolation);
    this.valueSize = 1;
    this.isNumberTrack = true;
  }
  evaluate(time, target) {
    if (!this.times.length) {
      if (Array.isArray(target) || ArrayBuffer.isView(target)) { target[0] = 0; return target; }
      return 0;
    }
    const { i, t } = this._search(time);
    const v = this.values;
    let out;
    if (this.interpolation === 'step' || i >= this.times.length - 1) {
      out = v[i] ?? 0;
    } else {
      const k = evalInterp(this.interpolation, t);
      out = (v[i] ?? 0) * (1 - k) + (v[i + 1] ?? 0) * k;
    }
    if (Array.isArray(target) || ArrayBuffer.isView(target)) {
      target[0] = out;
      return target;
    }
    return out;
  }
  clone() {
    const c = new NumberKeyframeTrack(this.name, Float32Array.from(this.times), Float32Array.from(this.values), this.interpolation);
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

// Pista de Color RGB (0..1 floats).
export class ColorKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, interpolation = 'linear') {
    super(name, times, values, interpolation);
    this.valueSize = 3;
    this.isColorTrack = true;
  }
  evaluate(time, target) {
    if (!this.times.length) return target;
    const { i, t } = this._search(time);
    const s = 3, v = this.values;
    let r, g, b;
    if (this.interpolation === 'step' || i >= this.times.length - 1) {
      const a = i * s;
      r = v[a] ?? 0; g = v[a + 1] ?? 0; b = v[a + 2] ?? 0;
    } else {
      const k = evalInterp(this.interpolation, t);
      const a = i * s, idxB = (i + 1) * s, w = 1 - k;
      r = (v[a] ?? 0) * w + (v[idxB] ?? 0) * k;
      g = (v[a + 1] ?? 0) * w + (v[idxB + 1] ?? 0) * k;
      b = (v[a + 2] ?? 0) * w + (v[idxB + 2] ?? 0) * k;
    }
    if (target && typeof target.set === 'function') return target.set(r, g, b);
    if (Array.isArray(target) || ArrayBuffer.isView(target)) {
      target[0] = r; target[1] = g; target[2] = b;
      return target;
    }
    return { r, g, b };
  }
  clone() {
    const c = new ColorKeyframeTrack(this.name, Float32Array.from(this.times), Float32Array.from(this.values), this.interpolation);
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

// Pista booleana con evaluación escalón (p. ej. visibilidad, wireframe, sombras).
export class BooleanKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, interpolation = 'step') {
    const numVals = Array.from(values || [], (v) => (v ? 1 : 0));
    super(name, times, numVals, interpolation || 'step');
    this.valueSize = 1;
    this.interpolation = 'step';
    this.isBooleanTrack = true;
  }
  evaluate(time, target) {
    if (!this.times.length) {
      if (Array.isArray(target) || ArrayBuffer.isView(target)) { target[0] = 0; return target; }
      return false;
    }
    const { i } = this._search(time);
    const out = (this.values[i] ?? 0) >= 0.5;
    if (Array.isArray(target) || ArrayBuffer.isView(target)) {
      target[0] = out ? 1 : 0;
      return target;
    }
    return out;
  }
  setKeyframe(time, valArr, opts) {
    const raw = Array.isArray(valArr) ? valArr[0] : valArr;
    return super.setKeyframe(time, [raw ? 1 : 0], opts);
  }
  clone() {
    const c = new BooleanKeyframeTrack(this.name, Float32Array.from(this.times), Float32Array.from(this.values), 'step');
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

// Pista de referencias discretas (p. ej. cambio de texturas `material.map` a lo largo del tiempo).
export class ObjectKeyframeTrack extends KeyframeTrack {
  constructor(name, times = [], values = [], interpolation = 'step') {
    super(name, times, [], 'step');
    this.values = Array.isArray(values) ? values.slice() : Array.from(values || []);
    this.valueSize = 1;
    this.interpolation = 'step';
    this.isObjectTrack = true;
  }
  evaluate(time) {
    if (!this.times.length) return null;
    const { i } = this._search(time);
    return this.values[i] ?? null;
  }
  getKeyframeValueAt(time, eps = 0.035) {
    const idx = this.getKeyframeIndexAt(time, eps);
    if (idx < 0) return null;
    return {
      index: idx,
      time: this.times[idx],
      values: [this.values[idx] ?? null],
    };
  }
  setKeyframe(time, valArr, { mergeEps = 0.035 } = {}) {
    const t = roundKeyframeTime(time);
    const val = Array.isArray(valArr) ? (valArr[0] ?? null) : (valArr ?? null);
    const times = Array.from(this.times);
    const values = this.values.slice();

    const existingIdx = this.getKeyframeIndexAt(t, mergeEps);
    if (existingIdx >= 0) {
      times[existingIdx] = t;
      values[existingIdx] = val;
      this.times = Float32Array.from(times);
      this.values = values;
      return { index: existingIdx, time: t, replaced: true };
    }

    let insertIdx = times.length;
    for (let i = 0; i < times.length; i++) {
      if (times[i] > t) {
        insertIdx = i;
        break;
      }
    }
    times.splice(insertIdx, 0, t);
    values.splice(insertIdx, 0, val);
    this.times = Float32Array.from(times);
    this.values = values;
    return { index: insertIdx, time: t, replaced: false };
  }
  removeKeyframeAt(time, eps = 0.035) {
    const times = Array.from(this.times);
    const values = this.values.slice();
    let removed = false;
    for (let i = times.length - 1; i >= 0; i--) {
      if (Math.abs(times[i] - time) <= eps) {
        times.splice(i, 1);
        values.splice(i, 1);
        removed = true;
      }
    }
    if (removed) {
      this.times = Float32Array.from(times);
      this.values = values;
    }
    return removed;
  }
  moveKeyframe(fromTime, toTime, { eps = 0.035, mergeEps = 0.025, merge = false } = {}) {
    const idx = this.getKeyframeIndexAt(fromTime, eps);
    if (idx < 0) return false;
    const destTime = roundKeyframeTime(toTime);
    const movedVal = this.values[idx] ?? null;

    const entries = [];
    for (let i = 0; i < this.times.length; i++) {
      if (i === idx) continue;
      const kt = this.times[i];
      if (merge && Math.abs(kt - destTime) <= mergeEps) continue;
      entries.push({ t: kt, v: this.values[i] ?? null, isMoved: false });
    }
    entries.push({ t: destTime, v: movedVal, isMoved: true });
    entries.sort((a, b) => (a.t !== b.t ? a.t - b.t : (a.isMoved ? 1 : -1)));

    this.times = Float32Array.from(entries.map((e) => e.t));
    this.values = entries.map((e) => e.v);
    return true;
  }
  captureSnapshot() {
    return {
      trackRef: this,
      name: this.name,
      property: this.property || null,
      target: this.target || null,
      valueSize: 1,
      interpolation: 'step',
      times: Float32Array.from(this.times),
      values: this.values.slice(),
    };
  }
  restoreSnapshot(snap) {
    if (!snap) return this;
    this.name = snap.name ?? this.name;
    this.property = snap.property ?? null;
    this.target = snap.target ?? null;
    this.valueSize = 1;
    this.interpolation = 'step';
    this.times = Float32Array.from(snap.times || []);
    this.values = Array.isArray(snap.values) ? snap.values.slice() : Array.from(snap.values || []);
    return this;
  }
  clone() {
    const c = new ObjectKeyframeTrack(this.name, Float32Array.from(this.times), this.values.slice(), 'step');
    c.target = this.target;
    c.property = this.property;
    return c;
  }
}

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
      const { property } = splitTrackNameAndProperty(track.name, track.property);
      return { object: track.target, property };
    }
    const { nodePath, property } = splitTrackNameAndProperty(track.name, track.property);
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
    const continuous = this.tracks.find((tr) => !tr.isBooleanTrack && !tr.isObjectTrack);
    return (continuous || this.tracks[0]).interpolation || 'linear';
  }

  setInterpolation(interpolation = 'linear') {
    for (const tr of this.tracks) {
      if (tr.isBooleanTrack || tr.isObjectTrack) continue;
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

  getOrCreateTrack(obj, property, valueSize = null, sampleValues = null) {
    let track = this.getTrackByTarget(obj, property);
    if (!track) {
      const baseName = `${obj.name || `Obj_${obj.id}`}.${property}`;
      const defaultInterp = this.getInterpolation();
      const kind = getAnimatedPropertyKind(property, valueSize, sampleValues);
      if (kind === 'quaternion') {
        track = new QuaternionKeyframeTrack(baseName, [], [], defaultInterp);
      } else if (kind === 'boolean') {
        track = new BooleanKeyframeTrack(baseName, [], [], 'step');
      } else if (kind === 'object') {
        track = new ObjectKeyframeTrack(baseName, [], [], 'step');
      } else if (kind === 'color') {
        track = new ColorKeyframeTrack(baseName, [], [], defaultInterp);
      } else if (kind === 'number') {
        track = new NumberKeyframeTrack(baseName, [], [], defaultInterp);
      } else if (kind === 'numberArray') {
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
      const tr = this.getOrCreateTrack(obj, prop, valArr.length, valArr);
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
      const { property: prop } = splitTrackNameAndProperty(tr.name, tr.property);
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
      const tr = this.getOrCreateTrack(obj, prop, entry.valueSize || entry.values.length, entry.values);
      if (entry.interpolation && !tr.times.length && !tr.isBooleanTrack && !tr.isObjectTrack) {
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

      if (track.isObjectTrack || OBJECT_PROPS.has(prop)) {
        const objVal = track.evaluate(localTime);
        if (applyAnimatedProperty(object, prop, objVal)) updated.add(object);
        continue;
      }
      if (track.isBooleanTrack || BOOLEAN_PROPS.has(prop)) {
        const boolVal = Boolean(track.evaluate(localTime));
        if (applyAnimatedProperty(object, prop, boolVal)) updated.add(object);
        continue;
      }
      if (track.isNumberTrack || NUMBER_PROPS.has(prop) || (track.valueSize === 1 && !Array.isArray(object[prop]) && !ArrayBuffer.isView(object[prop]))) {
        const numVal = track.evaluate(localTime);
        if (applyAnimatedProperty(object, prop, numVal)) updated.add(object);
        continue;
      }
      if (track.isColorTrack || COLOR_PROPS.has(prop)) {
        track.evaluate(localTime, _evalColor);
        if (applyAnimatedProperty(object, prop, _evalColor)) updated.add(object);
        continue;
      }

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
        const { nodePath } = splitTrackNameAndProperty(tr.name, tr.property);
        const rootName = nodePath.includes('/') ? nodePath.split('/')[0] : nodePath;
        if (rootName && (target.name === rootName || target.getObjectByName(rootName))) return true;
      }
      return false;
    });
  }
}
