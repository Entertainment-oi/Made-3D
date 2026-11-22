import { Object3D } from '../core/Object3D.js';
import { Mesh } from './Mesh.js';
import { Geometry } from '../geometry/Geometry.js';
import { BasicMaterial } from '../materials/BuiltinMaterials.js';
import { Color } from '../math/Color.js';
import { DEG2RAD } from '../math/utils.js';

function appendBox(positions, colors, minX, minY, minZ, maxX, maxY, maxZ, r, g, b) {
  const pushTri = (ax, ay, az, bx, by, bz, cx, cy, cz, shade) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const cr = r * shade, cg = g * shade, cb = b * shade;
    colors.push(cr, cg, cb, cr, cg, cb, cr, cg, cb);
  };
  const pushQuad = (ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, shade) => {
    pushTri(ax, ay, az, bx, by, bz, cx, cy, cz, shade);
    pushTri(ax, ay, az, cx, cy, cz, dx, dy, dz, shade);
  };
  // Frente (-Z) y Atrás (+Z)
  pushQuad(minX, minY, minZ, maxX, minY, minZ, maxX, maxY, minZ, minX, maxY, minZ, 0.85);
  pushQuad(maxX, minY, maxZ, minX, minY, maxZ, minX, maxY, maxZ, maxX, maxY, maxZ, 0.72);
  // Arriba (+Y) y Abajo (-Y)
  pushQuad(minX, maxY, minZ, maxX, maxY, minZ, maxX, maxY, maxZ, minX, maxY, maxZ, 1.0);
  pushQuad(minX, minY, maxZ, maxX, minY, maxZ, maxX, minY, minZ, minX, minY, minZ, 0.55);
  // Derecha (+X) e Izquierda (-X)
  pushQuad(maxX, minY, minZ, maxX, minY, maxZ, maxX, maxY, maxZ, maxX, maxY, minZ, 0.88);
  pushQuad(minX, minY, maxZ, minX, minY, minZ, minX, maxY, minZ, minX, maxY, maxZ, 0.68);
}

function buildCameraBodyGeometry() {
  const pos = [];
  const col = [];
  // Cuerpo principal de la cámara
  appendBox(pos, col, -0.17, -0.12, -0.06, 0.17, 0.12, 0.24, 0.28, 0.34, 0.45);
  // Visor / zapata superior
  appendBox(pos, col, -0.09, 0.12, 0.0, 0.09, 0.20, 0.17, 0.42, 0.49, 0.62);
  // Barril del lente mirando hacia -Z
  appendBox(pos, col, -0.10, -0.09, -0.20, 0.10, 0.09, -0.06, 0.18, 0.22, 0.30);
  // Acento del lente frontal
  appendBox(pos, col, -0.075, -0.065, -0.225, 0.075, 0.065, -0.20, 0.22, 0.74, 0.97);

  const geo = new Geometry();
  geo.setAttribute('position', new Float32Array(pos), 3);
  geo.setAttribute('color', new Float32Array(col), 3);
  geo.computeNormals();
  return geo;
}

/**
 * Helper 3D para visualizar una Camera (cuerpo de cámara, pirámide frustum y flecha de orientación +Y).
 * Se adjunta como hijo de la cámara (`cam.add(new CameraHelper(cam))`) o como hermano sincronizado.
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
      opacity: opts.opacity ?? 0.92,
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

    const bodyGeo = buildCameraBodyGeometry();
    const bodyMat = new BasicMaterial({
      vertexColors: true,
      color: 0xffffff,
      fog: false,
      side: 'double',
    });
    this.bodyMesh = new Mesh(bodyGeo, bodyMat);
    this.bodyMesh.frustumCulled = false;
    this.bodyMesh.castShadow = false;
    this.bodyMesh.receiveShadow = false;
    this.bodyMesh.isCameraHelper = true;
    this.bodyMesh.exportable = false;

    this.add(this.bodyMesh, this.linesMesh);
    this._lastSig = '';
    this.setCamera(camera);
    this.update();
  }

  setCamera(camera) {
    this.camera = camera || null;
    this.bodyMesh.pickTarget = this.camera;
    this.bodyMesh.ownerCamera = this.camera;
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
    this.bodyMesh.visible = vis;
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
        if (c === source.bodyMesh || c === source.linesMesh) continue;
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
    this.bodyMesh.geometry.dispose();
    this.bodyMesh.material.dispose();
    return this;
  }
}
