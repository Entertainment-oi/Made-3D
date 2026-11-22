import { clamp } from '../math/utils.js';
import { Quat } from '../math/Quat.js';

const _v3 = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
const _q = new Quat();
const _q2 = new Quat();
const _q4 = new Quat();

/**
 * Acción de animación: un clip reproduciéndose sobre unos objetos.
 * Bucle: 'repeat' (repetir), 'once' (una vez y parar) o 'pingpong' (ida y vuelta).
 */
export class AnimationAction {
  constructor(mixer, clip, loop = 'repeat') {
    this.mixer = mixer;
    this.clip = clip;
    this.time = 0;
    this.loop = loop;
    this.weight = 1;          // con qué peso se aplica (0..1)
    this.playing = true;
    this.playbackRate = 1;
    this.duration = clip ? clip.duration : 0;
    this._dir = 1;
    this._applyFinished = false;
  }
  play() { this.playing = true; this._applyFinished = false; return this; }
  pause() { this.playing = false; return this; }
  stop() { this.playing = false; this._applyFinished = false; this.time = 0; this._dir = 1; return this; }
  reset() { this.time = 0; this._dir = 1; this._applyFinished = false; return this; }
  setLoop(mode) { this.loop = mode; return this; }
  setWeight(w) { this.weight = clamp(w, 0, 1); return this; }

  // Avanza el tiempo del clip (con el bucle aplicado).
  advance(dt) {
    const d = this.duration > 0 ? this.duration : (this.clip && this.clip.duration > 0 ? this.clip.duration : 0);
    if (!(d > 0)) { this.time = 0; return this; }
    if (this.loop === 'pingpong') {
      const period = d * 2;
      const step = dt % period;
      let t = this.time + step * this._dir;
      while (t > d || t < 0) {
        if (t > d) { t = period - t; this._dir = -this._dir; }
        else { t = -t; this._dir = -this._dir; }
      }
      this.time = t;
      return this;
    }
    this.time += dt;
    if (this.time >= d) {
      if (this.loop === 'once') { this.time = d; this.playing = false; this._applyFinished = true; }
      else this.time %= d;
    } else if (this.time < 0) {
      if (this.loop === 'once') { this.time = 0; this.playing = false; this._applyFinished = true; }
      else this.time = ((this.time % d) + d) % d;
    }
    return this;
  }
}

/**
 * Mezclador de animaciones: lleva los clips sobre los objetos de un árbol.
 *
 *   const mixer = new AnimationMixer(scene);
 *   mixer.clipAction(clip).play();
 *   mixer.update(dt);            // en el bucle de render
 */
export class AnimationMixer {
  constructor(root) {
    this.root = root;
    this.actions = [];
    this.time = 0;
    this.timeScale = 1;
    this._cache = new WeakMap();
    this._groups = new Map();
    this._arrayGroups = new Map();
    this._evalScratch = [];
  }

  // Acción de un clip (la crea si no existe).
  clipAction(clip, loop = null) {
    let a = null;
    for (const x of this.actions) if (x.clip === clip) { a = x; break; }
    if (!a) { a = new AnimationAction(this, clip, loop || 'repeat'); this.actions.push(a); }
    else if (loop) a.setLoop(loop);
    return a;
  }

  getClip(name) {
    for (const a of this.actions) if (a.clip && a.clip.name === name) return a.clip;
    return null;
  }

  stopAllAction() { for (const a of this.actions) a.stop(); return this; }
  invalidateCache() { this._cache = new WeakMap(); return this; }

  // Avanza todas las acciones y aplica sus pistas.
  update(delta) {
    const dt = delta * this.timeScale;
    this.time += dt;
    for (let i = 0; i < this.actions.length; i++) {
      const a = this.actions[i];
      if (a.playing) a.advance(dt * a.playbackRate);
    }
    this._applyAll();
    return this;
  }

  /**
   * Aplica las pistas de todas las acciones. Las acciones que tocan la misma propiedad se
   * mezclan por peso (media ponderada); si el peso total es menor que 1, el resultado se
   * mezcla con el valor que había antes de la animación.
   */
  _applyAll() {
    const groups = this._groups;
    const arrayGroups = this._arrayGroups;
    groups.clear();
    arrayGroups.clear();

    for (let ai = 0; ai < this.actions.length; ai++) {
      const a = this.actions[ai];
      const active = a.playing || a._applyFinished;
      a._applyFinished = false;
      if (!active || !a.clip) continue;
      const w = a.weight;
      if (w <= 0) continue;
      const tracks = a.clip.tracks;
      for (let ti = 0; ti < tracks.length; ti++) {
        const track = tracks[ti];
        const t = this._resolve(track);
        if (!t) continue;
        const obj = t.object;
        const prop = t.property === 'weights' ? 'morphTargetInfluences' : t.property;
        const value = obj[prop];
        if (!value) continue;

        if (Array.isArray(value) || ArrayBuffer.isView(value)) {
          const key = obj.id + '.' + prop;
          let ag = arrayGroups.get(key);
          const len = Math.max(value.length, track.valueSize || 0);
          if (!ag) {
            const base = new Float32Array(len);
            for (let j = 0; j < value.length; j++) base[j] = value[j] || 0;
            ag = { obj, prop, total: 0, acc: new Float32Array(len), base };
            arrayGroups.set(key, ag);
          }
          const evalOut = track.evaluate(a.time, this._evalScratch);
          for (let j = 0; j < len; j++) ag.acc[j] += (evalOut[j] || 0) * w;
          ag.total += w;
          continue;
        }

        const key = obj.id + '.' + prop;
        let g = groups.get(key);
        if (!g) {
          g = {
            obj, prop, total: 0, x: 0, y: 0, z: 0, w: 0,
            ox: value.x, oy: value.y, oz: value.z, ow: value.w === undefined ? 1 : value.w,
            isQuat: prop === 'quaternion',
          };
          groups.set(key, g);
        }
        const quat = track.valueSize === 4;
        const v = quat ? track.evaluate(a.time, _q4) : track.evaluate(a.time, _v3);
        let vx = v.x, vy = v.y, vz = v.z, vw = quat ? v.w : 0;
        if (quat && g.total > 0 && (g.x * vx + g.y * vy + g.z * vz + g.w * vw) < 0) {
          vx = -vx; vy = -vy; vz = -vz; vw = -vw;
        }
        g.x += vx * w; g.y += vy * w; g.z += vz * w; g.w += vw * w;
        g.total += w;
      }
    }
    for (const g of groups.values()) {
      const t = g.total, value = g.obj[g.prop];
      if (g.isQuat) {
        if (t >= 1) {
          _q.set(g.x / t, g.y / t, g.z / t, g.w / t).normalize();
          value.set(_q.x, _q.y, _q.z, _q.w);
        } else {
          _q.set(g.ox, g.oy, g.oz, g.ow);
          _q2.set(g.x / t, g.y / t, g.z / t, g.w / t).normalize();
          _q.slerp(_q2, t);
          value.set(_q.x, _q.y, _q.z, _q.w);
        }
      } else if (t >= 1) {
        value.set(g.x / t, g.y / t, g.z / t);
      } else {
        value.set(g.ox + (g.x / t - g.ox) * t, g.oy + (g.y / t - g.oy) * t, g.oz + (g.z / t - g.oz) * t);
      }
    }
    for (const ag of arrayGroups.values()) {
      const target = ag.obj[ag.prop];
      const t = ag.total;
      const count = Array.isArray(target) ? ag.acc.length : Math.min(target.length, ag.acc.length);
      for (let j = 0; j < count; j++) {
        const avg = ag.acc[j] / t;
        target[j] = t >= 1 ? avg : ag.base[j] + (avg - ag.base[j]) * t;
      }
    }
  }

  // Resuelve el objeto y la propiedad de una pista.
  _resolve(track) {
    if (track.target) {
      const i = track.name ? track.name.lastIndexOf('.') : -1;
      const property = track.property || (i >= 0 ? track.name.slice(i + 1) : 'position');
      return { object: track.target, property };
    }
    const cached = this._cache.get(track);
    if (cached && cached.root === this.root) return cached.res;
    const i = track.name.lastIndexOf('.');
    const property = track.property || (i >= 0 ? track.name.slice(i + 1) : 'position');
    const obj = this._find(i >= 0 ? track.name.slice(0, i) : track.name);
    if (!obj) return null;
    const res = { object: obj, property };
    this._cache.set(track, { root: this.root, res });
    return res;
  }

  // Busca un objeto por nombre (o por ruta 'a/b/c') en el árbol del mixer.
  _find(path) {
    if (!path) return this.root;
    if (path.indexOf('/') >= 0) {
      let cur = this.root;
      for (const part of path.split('/')) {
        if (!cur) return null;
        cur = cur.children.find((c) => c.name === part) || null;
      }
      return cur;
    }
    return this.root.getObjectByName(path);
  }

  /**
   * Qué animaciones mueven un objeto. Sirve para el picking: al elegir un hueso (o una malla)
   * te dice qué clip y qué pista lo están animando.
   * Devuelve [{ action, clip, track, property, time }].
   */
  findTracks(target) {
    const out = [];
    for (const a of this.actions) {
      if (!a.clip) continue;
      for (const track of a.clip.tracks) {
        const t = this._resolve(track);
        if (t && t.object === target) out.push({ action: a, clip: a.clip, track, property: t.property, time: a.time });
      }
    }
    return out;
  }
}
