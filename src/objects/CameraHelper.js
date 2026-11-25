import { Object3D } from '../core/Object3D.js';
import { Mesh } from './Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Color } from '../math/Color.js';
import { DEG2RAD } from '../math/utils.js';

/**
 * Helper 3D en líneas wireframe para visualizar una Camera (pirámide frustum y flecha de orientación +Y),
 * sin modelo sólido de cuerpo 3D.
 */
export class CameraHelper extends Object3D {
  constructor(camera = null, opts = {}) {
    super();
    this.isCameraHelper = true;
    this.camera = camera || null;
    this.previewLength = opts.previewLength ?? 1.6;
    this.color = new Color(opts.color ?? 0x38bdf8);
    this.selectedColor = new Color(opts.selectedColor ?? 0xffaa40);
    this.upColor = new Color(opts.upColor ?? 0xfbbf24);
    this.selected = false;
    this.exportable = false;

    const lineGeo = new Geometry();
    const lineMat = new BasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      fog: false,
      depthTest: true,
      transparent: true,
      opacity: opts.opacity ?? 0.94,
    });
    this.linesMesh = new Mesh(lineGeo, lineMat);
    this.linesMesh.drawMode = 'lines';
    this.linesMesh.frustumCulled = false;
    this.linesMesh.castShadow = false;
    this.linesMesh.receiveShadow = false;
    this.linesMesh.renderOrder = opts.renderOrder ?? 990;
    this.linesMesh.pickable = false;
    this.linesMesh.outline = false;
    this.linesMesh.exportable = false;
    this.linesMesh.isCameraHelper = true;

    this.add(this.linesMesh);
    this._lastSig = '';
    this.setCamera(camera);
    this.update();
  }

  setCamera(camera) {
    this.camera = camera || null;
    if (this.linesMesh) {
      this.linesMesh.ownerCamera = this.camera;
      this.linesMesh.pickTarget = this.camera;
    }
    this._lastSig = '';
    return this;
  }

  setSelected(selected) {
    const next = Boolean(selected);
    if (this.selected !== next) {
      this.selected = next;
      this._lastSig = '';
      this.update();
    }
    return this;
  }

  onBeforeRender(renderer, activeCamera) {
    const viewingThroughSelf = Boolean(
      this.camera &&
        activeCamera &&
        (activeCamera === this.camera ||
          activeCamera.sourceCamera === this.camera ||
          (activeCamera.userData && activeCamera.userData.sourceCamera === this.camera))
    );
    const vis = !viewingThroughSelf;
    this.linesMesh.visible = vis;
    if (vis) this.update();
  }

  update() {
    const cam = this.camera;
    const L = Math.max(0.25, this.previewLength);
    let minX = -0.8, maxX = 0.8, minY = -0.45, maxY = 0.45;
    let sig = `default|${L}|${this.selected ? 1 : 0}`;

    if (cam && cam.fov !== undefined) {
      const rw = cam.renderWidth || 0;
      const rh = cam.renderHeight || 0;
      const aspect = rw > 0 && rh > 0 ? rw / rh : (cam.aspect || 16 / 9);
      const hh = L * Math.tan((cam.fov * 0.5) * DEG2RAD);
      const hw = hh * aspect;
      minX = -hw; maxX = hw;
      minY = -hh; maxY = hh;
      sig = `P|${cam.fov.toFixed(3)}|${aspect.toFixed(4)}|${L}|${this.selected ? 1 : 0}`;
    } else if (cam && cam.left !== undefined) {
      minX = cam.left; maxX = cam.right;
      minY = cam.bottom; maxY = cam.top;
      sig = `O|${minX.toFixed(3)}|${maxX.toFixed(3)}|${minY.toFixed(3)}|${maxY.toFixed(3)}|${L}|${this.selected ? 1 : 0}`;
    }

    if (sig === this._lastSig) return this;
    this._lastSig = sig;

    const z = -L;
    const frameW = maxX - minX;
    const frameH = maxY - minY;
    const cx = (minX + maxX) * 0.5;
    const triBaseY = maxY + frameH * 0.08;
    const triTopY = maxY + frameH * 0.34;
    const triHalfW = Math.max(0.12, frameW * 0.14);

    // 4 rayos desde origen + 4 bordes del rectángulo + 3 segmentos del triángulo UP = 11 segmentos (22 vértices)
    const segs = [
      // Rayos desde el ápice (0,0,0) hacia las 4 esquinas
      [0, 0, 0, minX, minY, z, 0],
      [0, 0, 0, maxX, minY, z, 0],
      [0, 0, 0, maxX, maxY, z, 0],
      [0, 0, 0, minX, maxY, z, 0],
      // Rectángulo frontal del encuadre
      [minX, minY, z, maxX, minY, z, 1],
      [maxX, minY, z, maxX, maxY, z, 1],
      [maxX, maxY, z, minX, maxY, z, 1],
      [minX, maxY, z, minX, minY, z, 1],
      // Triángulo superior UP (+Y)
      [cx - triHalfW, triBaseY, z, cx + triHalfW, triBaseY, z, 2],
      [cx + triHalfW, triBaseY, z, cx, triTopY, z, 2],
      [cx, triTopY, z, cx - triHalfW, triBaseY, z, 2],
    ];

    const geo = this.linesMesh.geometry;
    const vertCount = segs.length * 2;
    let posArr = geo.attributes.position && geo.attributes.position.array;
    let colArr = geo.attributes.color && geo.attributes.color.array;
    if (!posArr || posArr.length !== vertCount * 3) {
      posArr = new Float32Array(vertCount * 3);
      colArr = new Float32Array(vertCount * 3);
      geo.setAttribute('position', posArr, 3);
      geo.setAttribute('color', colArr, 3);
    }

    const baseCol = this.selected ? this.selectedColor : this.color;
    const upCol = this.selected ? this.selectedColor : this.upColor;

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const o = i * 6;
      posArr[o] = s[0]; posArr[o + 1] = s[1]; posArr[o + 2] = s[2];
      posArr[o + 3] = s[3]; posArr[o + 4] = s[4]; posArr[o + 5] = s[5];
      const kind = s[6];
      const c = kind === 2 ? upCol : baseCol;
      const shade = kind === 0 ? (this.selected ? 0.92 : 0.72) : 1.0;
      colArr[o] = c.r * shade; colArr[o + 1] = c.g * shade; colArr[o + 2] = c.b * shade;
      colArr[o + 3] = c.r * shade; colArr[o + 4] = c.g * shade; colArr[o + 5] = c.b * shade;
    }

    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    return this;
  }

  copy(source, recursive = true) {
    super.copy(source, false);
    this.previewLength = source.previewLength ?? 1.6;
    if (source.color) this.color.copy(source.color);
    if (source.selectedColor) this.selectedColor.copy(source.selectedColor);
    if (source.upColor) this.upColor.copy(source.upColor);
    this.selected = Boolean(source.selected);
    this.exportable = source.exportable !== undefined ? source.exportable : false;
    if (source.linesMesh && this.linesMesh) {
      this.linesMesh.renderOrder = source.linesMesh.renderOrder;
      if (source.linesMesh.material && this.linesMesh.material) {
        this.linesMesh.material.opacity = source.linesMesh.material.opacity;
      }
    }
    if (recursive && source.children) {
      for (let i = 0; i < source.children.length; i++) {
        const c = source.children[i];
        if (c === source.linesMesh) continue;
        this.add(c.clone(true));
      }
    }
    this.setCamera(source.camera);
    this.update();
    return this;
  }

  dispose() {
    this.linesMesh.geometry.dispose();
    this.linesMesh.material.dispose();
    return this;
  }
}
