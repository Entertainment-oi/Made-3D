import { Raycaster } from '../core/Raycaster.js';
import { Vec3 } from '../math/Vec3.js';
import { pointSegment2D } from '../core/raycast.js';
import { clientToLocalPointFromRect } from '../core/viewportCoords.js';

const _v1 = new Vec3(), _v2 = new Vec3(), _v3 = new Vec3();
const _p1 = new Vec3(), _p2 = new Vec3();

/**
 * Picking: elegir con el ratón (o el dedo) una malla, un hueso o la animación que lo mueve.
 *
 *   const picker = new Picker(renderer.domElement);
 *   renderer.domElement.addEventListener('pointerdown', (e) => {
 *     const hit = picker.pick(e, camera, scene);
 *     if (!hit) return;
 *     if (hit.type === 'bone') console.log('hueso', hit.bone.name, hit.animation?.clip.name);
 *     else console.log('malla', hit.object.name, hit.point);
 *   });
 *
 * Opciones:
 *   boneTolerance  píxeles de margen alrededor del hueso (10 por defecto)
 *   prefer         'bone' (el hueso gana si está bajo el puntero), 'mesh' o 'auto' (el más cercano)
 *   mixer          AnimationMixer para saber qué clip/pista mueve lo que has elegido
 */
export class Picker {
  constructor(domElement = null, opts = {}) {
    this.dom = domElement || null;
    this.raycaster = new Raycaster();
    this.boneTolerance = opts.boneTolerance ?? 10;
    this.lightTolerance = opts.lightTolerance ?? 20;
    this.cameraTolerance = opts.cameraTolerance ?? 20;
    this.prefer = opts.prefer ?? 'bone';     // 'bone' | 'mesh' | 'auto'
    this.mixer = opts.mixer || null;
    this.filter = opts.filter || null;       // fn(object) -> boolean
    this.cycleOverlap = opts.cycleOverlap !== false; // alternar huesos superpuestos al repetir clic
    this._w = 0; this._h = 0;
    this._lastBonePick = null;
  }

  setMixer(mixer) { this.mixer = mixer; return this; }
  setFilter(fn) { this.filter = fn || null; return this; }
  setSize(w, h) { this._w = w; this._h = h; return this; }
  invalidateCache() { this._lastBonePick = null; return this; }

  // Tamaño del lienzo en píxeles CSS (el que se usa para proyectar a pantalla).
  get width() { return this.dom ? (this.dom.clientWidth || this.dom.width || 1) : (this._w || 1); }
  get height() { return this.dom ? (this.dom.clientHeight || this.dom.height || 1) : (this._h || 1); }

  // Elige con un evento de puntero (clientX/clientY).
  pick(event, camera, scene) {
    const [x, y] = this._xy(event);
    return this.pickAt(x, y, camera, scene);
  }

  // Elige con coordenadas en píxeles del lienzo (origen arriba a la izquierda).
  pickAt(x, y, camera, scene) {
    const W = this.width, H = this.height;
    return this.pickNdc(x / W * 2 - 1, -(y / H) * 2 + 1, camera, scene);
  }

  // Elige con coordenadas normalizadas (-1..1, y hacia arriba).
  pickNdc(ndcX, ndcY, camera, scene) {
    const roots = Array.isArray(scene) ? scene : [scene];
    if (!roots.length || !camera) return null;

    camera.updateWorldMatrix(true, false);
    camera.updateViewMatrix();
    const ray = this.raycaster.setFromCamera({ x: ndcX, y: ndcY }, camera);

    const hits = this.raycaster.intersectObjects(roots, true);
    let meshHit = null;
    for (const h of hits) {
      if (this._isPickAllowed(h.object, camera)) { meshHit = h; break; }
    }
    const boneHit = this._pickBone(ndcX, ndcY, camera, roots);
    const lightHit = this._pickLight(ndcX, ndcY, camera, roots);
    const cameraHit = this._pickCamera(ndcX, ndcY, camera, roots);

    let hit = null;
    if (boneHit && meshHit) {
      if (this.prefer === 'mesh') hit = meshHit;
      else if (this.prefer === 'auto') hit = boneHit.depth < meshHit.distance ? boneHit : meshHit;
      else hit = boneHit;
    } else hit = boneHit || meshHit;

    if (lightHit && (!hit || lightHit.depth < (hit.distance ?? hit.depth ?? Infinity) + 0.05)) {
      hit = lightHit;
    }
    if (cameraHit && (!hit || cameraHit.depth < (hit.distance ?? hit.depth ?? Infinity) + 0.05)) {
      hit = cameraHit;
    }

    if (!hit) { this._lastBonePick = null; return null; }
    if (hit.type !== 'bone') this._lastBonePick = null;

    const pickedObject = (hit.type !== 'bone' && hit.type !== 'light' && hit.type !== 'camera')
      ? (hit.object.getPickTarget ? hit.object.getPickTarget() : (hit.object.userData?.pickTarget || hit.object))
      : hit.object;

    const res = hit.type === 'bone' ? {
      type: 'bone',
      object: hit.bone,
      bone: hit.bone,
      candidates: hit.candidates || [hit.bone],
      distance: hit.depth,
      point: hit.point,
      boneT: hit.t,
      screenDistance: hit.px,
    } : hit.type === 'light' ? {
      type: 'light',
      object: hit.object,
      light: hit.object,
      distance: hit.depth,
      point: hit.point,
      screenDistance: hit.px,
    } : hit.type === 'camera' ? {
      type: 'camera',
      object: hit.object,
      camera: hit.object,
      distance: hit.depth,
      point: hit.point,
      screenDistance: hit.px,
    } : {
      type: 'mesh',
      object: pickedObject,
      hitObject: hit.object,
      distance: hit.distance,
      point: hit.point,
      normal: hit.normal,
      face: hit.face,
      faceIndex: hit.faceIndex,
      uv: hit.uv,
      instanceId: hit.instanceId,
    };

    // ¿Qué animación mueve esto?
    if (this.mixer) {
      const tracks = this.mixer.findTracks(res.object);
      res.animations = tracks;
      res.animation = tracks.length ? this._animInfo(tracks[0]) : null;
    }
    return res;
  }

  // Info de animación a partir de una pista (clip, pista, tiempo y keyframe actual).
  _animInfo(t) {
    const kf = t.track.nearestKeyframe(t.time);
    return {
      clip: t.clip,
      track: t.track,
      action: t.action,
      property: t.property,
      time: t.time,
      keyframe: kf,
      keyframeTime: t.track.times.length ? t.track.times[kf] : 0,
    };
  }

  // Elige entre una lista de objetos (sin recorrer la escena entera).
  pickFrom(objects, x, y, camera) {
    const W = this.width, H = this.height;
    camera.updateWorldMatrix(true, false);
    camera.updateViewMatrix();
    this.raycaster.setFromCamera({ x: x / W * 2 - 1, y: -(y / H) * 2 + 1 }, camera);
    const hits = this.raycaster.intersectObjects(objects, true);
    return hits.length ? hits[0] : null;
  }

  // ───────── huesos ─────────
  // Busca los huesos bajo el puntero y alterna entre los superpuestos al hacer clic repetido.
  _pickBone(ndcX, ndcY, camera, roots) {
    const W = this.width, H = this.height;
    const px = (ndcX * 0.5 + 0.5) * W, py = (1 - (ndcY * 0.5 + 0.5)) * H;
    const ve = camera.matrixWorldInverse.elements;
    const isPersp = camera.fov !== undefined;
    const byBone = new Map();
    for (const bone of this._bones(roots)) {
      if (!bone.visible) continue;
      if (!this._isPickAllowed(bone, camera)) continue;
      const head0 = _v1.setFromMatrixPosition(bone.matrixWorld);
      const childBones = [];
      for (const c of bone.children) {
        if (c.isBone && c.visible && (c.isPickable ? c.isPickable() : (!c.userData || c.userData.pickable !== false))) childBones.push(c);
      }
      const tails = childBones.length
        ? childBones.map((c) => new Vec3().setFromMatrixPosition(c.matrixWorld))
        : [bone.getWorldTail(new Vec3())];

      for (const tail of tails) {
        const head = _v2.copy(head0);
        if (isPersp) {
          const z1 = -(ve[2] * head.x + ve[6] * head.y + ve[10] * head.z + ve[14]);
          const z2 = -(ve[2] * tail.x + ve[6] * tail.y + ve[10] * tail.z + ve[14]);
          if (z1 <= 0.01 && z2 <= 0.01) continue;   // los dos detrás de la cámara
          const hx0 = head.x, hy0 = head.y, hz0 = head.z;
          const tx0 = tail.x, ty0 = tail.y, tz0 = tail.z;
          if (z1 <= 0.01) {
            const k = (0.01 - z1) / (z2 - z1);
            head.set(hx0 + (tx0 - hx0) * k, hy0 + (ty0 - hy0) * k, hz0 + (tz0 - hz0) * k);
          } else if (z2 <= 0.01) {
            const k = (0.01 - z2) / (z1 - z2);
            tail.set(tx0 + (hx0 - tx0) * k, ty0 + (hy0 - ty0) * k, tz0 + (hz0 - tz0) * k);
          }
        }
        const p1 = _p1.copy(head).project(camera);
        const p2 = _p2.copy(tail).project(camera);
        const sx1 = (p1.x * 0.5 + 0.5) * W, sy1 = (1 - (p1.y * 0.5 + 0.5)) * H;
        const sx2 = (p2.x * 0.5 + 0.5) * W, sy2 = (1 - (p2.y * 0.5 + 0.5)) * H;
        const { t, d } = pointSegment2D(px, py, sx1, sy1, sx2, sy2);
        if (d > this.boneTolerance) continue;
        const wx = head.x + (tail.x - head.x) * t, wy = head.y + (tail.y - head.y) * t, wz = head.z + (tail.z - head.z) * t;
        const depth = this.raycaster.distanceToPoint(_v3.set(wx, wy, wz));
        if (depth < 0) continue;
        const cand = { type: 'bone', bone, depth, px: d, t, point: new Vec3(wx, wy, wz), level: this._level(bone) };
        const prev = byBone.get(bone);
        if (!prev || cand.px < prev.px - 0.5 || (Math.abs(cand.px - prev.px) <= 0.5 && cand.depth < prev.depth)) {
          byBone.set(bone, cand);
        }
      }
    }
    if (!byBone.size) { this._lastBonePick = null; return null; }

    const all = Array.from(byBone.values()).sort((a, b) => {
      if (Math.abs(a.px - b.px) > 0.5) return a.px - b.px;
      if (Math.abs(a.depth - b.depth) > 1e-4) return a.depth - b.depth;
      if (b.level !== a.level) return b.level - a.level;
      return a.bone.id - b.bone.id;
    });

    const best = all[0];
    const overlapping = all.filter((c) => c.px <= best.px + 4 && Math.abs(c.depth - best.depth) <= 0.15);
    const candidates = overlapping.map((c) => c.bone);

    let chosen = best;
    if (this.cycleOverlap && overlapping.length > 1) {
      const lp = this._lastBonePick;
      const sameSpot = lp && Math.hypot(px - lp.x, py - lp.y) <= 8;
      const sameSet = sameSpot && lp.bones.length === candidates.length && lp.bones.every((b, i) => b === candidates[i]);
      const idx = sameSet ? (lp.idx + 1) % overlapping.length : 0;
      chosen = overlapping[idx];
      this._lastBonePick = { x: px, y: py, bones: candidates, idx };
    } else {
      this._lastBonePick = { x: px, y: py, bones: candidates, idx: 0 };
    }

    chosen.candidates = candidates;
    return chosen;
  }

  // Cuántos huesos hay por encima de este (para desempatar en los nudos).
  _level(bone) {
    let n = 0, p = bone.parent;
    while (p) { if (p.isBone) n++; p = p.parent; }
    return n;
  }

  // ¿El punto está detrás de la cámara? (z del espacio de vista > 0).
  _behind(p, ve) {
    return -(ve[2] * p.x + ve[6] * p.y + ve[10] * p.z + ve[14]) <= 0;
  }

  // Todos los huesos visibles y seleccionables de los objetos indicados.
  _bones(roots) {
    const out = [];
    const walk = (o) => {
      if (!o || !o.visible) return;
      if (o.isPickable ? !o.isPickable() : (o.userData && o.userData.pickable === false)) return;
      if (o.isBone) out.push(o);
      for (const c of o.children) walk(c);
    };
    for (const r of roots) walk(r);
    return out;
  }

  _pickLight(ndcX, ndcY, camera, roots) {
    const W = this.width, H = this.height;
    const px = (ndcX * 0.5 + 0.5) * W, py = (1 - (ndcY * 0.5 + 0.5)) * H;
    const ve = camera.matrixWorldInverse.elements;
    let best = null;
    const walk = (o) => {
      if (!o || !o.visible) return;
      if (o.isLight && (o.isPointLight || o.isDirectionalLight) && this._isPickAllowed(o, camera)) {
        const wp = _v1.setFromMatrixPosition(o.matrixWorld);
        const z = -(ve[2] * wp.x + ve[6] * wp.y + ve[10] * wp.z + ve[14]);
        if (z > 0.02 || camera.fov === undefined) {
          const p = _p1.copy(wp).project(camera);
          const sx = (p.x * 0.5 + 0.5) * W;
          const sy = (1 - (p.y * 0.5 + 0.5)) * H;
          const d = Math.hypot(px - sx, py - sy);
          if (d <= this.lightTolerance) {
            const depth = this.raycaster.distanceToPoint(wp);
            if (!best || d < best.px - 2 || (Math.abs(d - best.px) <= 2 && depth < best.depth)) {
              best = { type: 'light', object: o, depth, px: d, point: wp.clone() };
            }
          }
        }
      }
      for (const c of o.children) walk(c);
    };
    for (const r of roots) walk(r);
    return best;
  }

  _pickCamera(ndcX, ndcY, camera, roots) {
    const W = this.width, H = this.height;
    const px = (ndcX * 0.5 + 0.5) * W, py = (1 - (ndcY * 0.5 + 0.5)) * H;
    const ve = camera.matrixWorldInverse.elements;
    const isPersp = camera.fov !== undefined;
    let best = null;

    const consider = (camObj, wPoint, pxDist) => {
      if (pxDist > this.cameraTolerance) return;
      const depth = this.raycaster.distanceToPoint(wPoint);
      if (depth < 0) return;
      if (!best || pxDist < best.px - 2 || (Math.abs(pxDist - best.px) <= 2 && depth < best.depth)) {
        best = { type: 'camera', object: camObj, depth, px: pxDist, point: wPoint.clone() };
      }
    };

    const walk = (o) => {
      if (!o || !o.visible) return;
      if (o.isCamera && this._isPickAllowed(o, camera)) {
        const isSelf =
          o === camera ||
          o === camera.sourceCamera ||
          (camera.userData && o === camera.userData.sourceCamera);
        if (!isSelf) {
          o.updateWorldMatrix(true, false);
          const wp = _v1.setFromMatrixPosition(o.matrixWorld);
          const z = -(ve[2] * wp.x + ve[6] * wp.y + ve[10] * wp.z + ve[14]);
          if (z > 0.02 || !isPersp) {
            const p = _p1.copy(wp).project(camera);
            const sx = (p.x * 0.5 + 0.5) * W;
            const sy = (1 - (p.y * 0.5 + 0.5)) * H;
            consider(o, wp, Math.hypot(px - sx, py - sy));
          }

          // También comprobar las líneas wireframe de cualquier CameraHelper hijo
          for (const ch of o.children) {
            if (!ch || !ch.isCameraHelper || !ch.linesMesh || !ch.linesMesh.visible) continue;
            const posAttr = ch.linesMesh.geometry?.attributes?.position;
            const arr = posAttr?.array;
            if (!arr) continue;
            ch.linesMesh.updateWorldMatrix(true, false);
            const mw = ch.linesMesh.matrixWorld;
            for (let i = 0; i + 5 < arr.length; i += 6) {
              const a = _v2.set(arr[i], arr[i + 1], arr[i + 2]).applyMatrix4(mw);
              const b = _v3.set(arr[i + 3], arr[i + 4], arr[i + 5]).applyMatrix4(mw);
              if (isPersp) {
                const z1 = -(ve[2] * a.x + ve[6] * a.y + ve[10] * a.z + ve[14]);
                const z2 = -(ve[2] * b.x + ve[6] * b.y + ve[10] * b.z + ve[14]);
                if (z1 <= 0.01 && z2 <= 0.01) continue;
                if (z1 <= 0.01) a.lerp(b, (0.01 - z1) / (z2 - z1));
                else if (z2 <= 0.01) b.lerp(a, (0.01 - z2) / (z1 - z2));
              }
              const pa = _p1.copy(a).project(camera);
              const pb = _p2.copy(b).project(camera);
              const sx1 = (pa.x * 0.5 + 0.5) * W, sy1 = (1 - (pa.y * 0.5 + 0.5)) * H;
              const sx2 = (pb.x * 0.5 + 0.5) * W, sy2 = (1 - (pb.y * 0.5 + 0.5)) * H;
              const { t, d } = pointSegment2D(px, py, sx1, sy1, sx2, sy2);
              if (d <= this.cameraTolerance) {
                const wHit = new Vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
                consider(o, wHit, d);
              }
            }
          }
        }
      }
      for (const c of o.children) walk(c);
    };
    for (const r of roots) walk(r);
    return best;
  }

  _isPickAllowed(obj, camera) {
    if (!obj) return false;
    if (obj.isPickable ? !obj.isPickable() : (obj.userData && (obj.userData.pickable === false || obj.userData.noPick === true))) {
      return false;
    }
    if (obj.ownerCamera && camera) {
      if (
        obj.ownerCamera === camera ||
        obj.ownerCamera === camera.sourceCamera ||
        (camera.userData && obj.ownerCamera === camera.userData.sourceCamera)
      ) {
        return false;
      }
    }
    if (this.filter && !this.filter(obj)) return false;
    return true;
  }

  // Coordenadas del evento dentro del lienzo (en píxeles CSS).
  _xy(e) {
    const el = this.dom;
    if (!el || !el.getBoundingClientRect) return [e.clientX, e.clientY];
    const r = el.getBoundingClientRect();
    return clientToLocalPointFromRect(r, e, this.width, this.height);
  }
}
