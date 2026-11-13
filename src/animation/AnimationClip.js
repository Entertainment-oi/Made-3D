import { Quat } from '../math/Quat.js';

/**
 * Pista de keyframes: una propiedad de un objeto que cambia a lo largo del tiempo.
 *
 * `name` dice a qué se aplica: 'Hombro.position' (objeto por nombre + propiedad) o, si quieres
 * atar el pista a un objeto concreto, `track.target = hueso` y `track.property = 'position'`.
 *
 * Propiedades admitidas: 'position', 'scale' (Vec3), 'quaternion' (Quat) y 'rotation' (Euler).
 * Interpolación: 'linear' (por defecto), 'step' o 'smooth'.
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
    let k = t;
    if (this.interpolation === 'smooth') k = t * t * (3 - 2 * t);
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
}

// Pista de Vector3: posición, escala o rotación (Euler).
export class VectorKeyframeTrack extends KeyframeTrack {
  constructor(name, times, values, interpolation = 'linear') {
    super(name, times, values, interpolation);
    this.valueSize = 3;
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
    let k = t;
    if (this.interpolation === 'smooth') k = t * t * (3 - 2 * t);
    target.set(q.x, q.y, q.z, q.w);
    return target.slerp(q2, k);
  }
}

const _q = new Quat(), _q2 = new Quat();

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
  addTrack(track) {
    this.tracks.push(track);
    if (track.duration > this.duration) this.duration = track.duration;
    return this;
  }
  getTrack(name) {
    for (const t of this.tracks) if (t.name === name) return t;
    return null;
  }
}
