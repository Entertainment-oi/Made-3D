import { Object3D } from '../core/Object3D.js';
import { Mat4 } from '../math/Mat4.js';
import { Vec3 } from '../math/Vec3.js';
import { Quat } from '../math/Quat.js';
import { DEG2RAD, RAD2DEG } from '../math/utils.js';

const _vfPos = new Vec3();
const _vfQuat = new Quat();

export class Camera extends Object3D {
  constructor() {
    super();
    this.isCamera = true;
    this.exportable = false;
    this.sourceCamera = null;
    this.projectionMatrix = new Mat4();
    this.viewMatrix = new Mat4();
  }
  get matrixWorldInverse() { return this.viewMatrix; }
  updateViewMatrix() { this.viewMatrix.copyInverse(this.matrixWorld); return this; }
  updateMatrixWorld() {
    super.updateMatrixWorld();
    this.viewMatrix.copyInverse(this.matrixWorld);
  }
  updateWorldMatrix(updateParents = false, updateChildren = false) {
    super.updateWorldMatrix(updateParents, updateChildren);
    this.viewMatrix.copyInverse(this.matrixWorld);
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.sourceCamera = source.sourceCamera || null;
    this.projectionMatrix.copy(source.projectionMatrix);
    this.viewMatrix.copy(source.viewMatrix);
    if (recursive) {
      for (let i = 0; i < this.children.length; i++) {
        const child = this.children[i];
        if (child && child.isCameraHelper && typeof child.setCamera === 'function') {
          child.setCamera(this);
          if (typeof child.update === 'function') child.update();
        }
      }
    }
    return this;
  }
}

export class PerspectiveCamera extends Camera {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 1000) {
    super();
    this.isPerspectiveCamera = true;
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.renderWidth = 1920;
    this.renderHeight = 1080;
    this.updateProjection();
  }
  updateProjection() {
    this.projectionMatrix.perspective(this.fov * DEG2RAD, this.aspect, this.near, this.far);
    return this;
  }
  updateProjectionMatrix() {
    return this.updateProjection();
  }
  getSafeRenderSize(renderer = null, opts = {}) {
    const minSize = opts.minSize ?? 64;
    const maxSize = opts.maxSize ?? 7680;
    const rawW = Math.max(minSize, Math.min(maxSize, Math.round((opts.width ?? this.renderWidth) || 1920)));
    const rawH = Math.max(minSize, Math.min(maxSize, Math.round((opts.height ?? this.renderHeight) || 1080)));
    if (renderer && typeof renderer.clampRenderSize === 'function') {
      return renderer.clampRenderSize(rawW, rawH, {
        minSize,
        maxSize,
        preserveAspect: opts.preserveAspect !== false,
      });
    }
    return { width: rawW, height: rawH, clamped: false, maxWidth: maxSize, maxHeight: maxSize };
  }
  static computeViewfinderFrame(viewportWidth, viewportHeight, targetAspect = 16 / 9, opts = {}) {
    const vpW = Math.max(1, viewportWidth || 1);
    const vpH = Math.max(1, viewportHeight || 1);
    const aspect = Number.isFinite(targetAspect) && targetAspect > 0 ? targetAspect : (16 / 9);
    const minSize = opts.minSize ?? 32;
    const padX = opts.paddingX ?? (vpW < 640 ? 28 : 96);
    const padY = opts.paddingY ?? (vpH < 520 ? 116 : 156);
    const maxW = Math.max(Math.max(60, minSize), vpW - padX);
    const maxH = Math.max(Math.max(60, minSize), vpH - padY);
    let rawW = maxW;
    let rawH = rawW / aspect;
    if (rawH > maxH) {
      rawH = maxH;
      rawW = rawH * aspect;
    }
    rawW = Math.max(minSize, rawW);
    rawH = Math.max(minSize, rawH);
    const width = Math.round(rawW);
    const height = Math.round(rawH);
    const left = Math.round((vpW - width) * 0.5);
    const top = Math.round((vpH - height) * 0.5);
    return {
      vpW,
      vpH,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      scaleRatio: vpH / Math.max(1, rawH),
    };
  }
  syncFromViewfinder(sourceCamera, viewportWidth, viewportHeight, frameHeight) {
    if (!sourceCamera) return this;
    sourceCamera.updateWorldMatrix(true, false);
    this.position.copy(sourceCamera.getWorldPosition(_vfPos));
    this.quaternion.copy(sourceCamera.getWorldQuaternion(_vfQuat));
    this.near = sourceCamera.near || 0.05;
    this.far = sourceCamera.far || 800;
    this.sourceCamera = sourceCamera;
    const vpW = Math.max(1, viewportWidth || 1);
    const vpH = Math.max(1, viewportHeight || 1);
    const scaleRatio = vpH / Math.max(1, frameHeight || vpH);
    const tanHalf = Math.tan(((sourceCamera.fov || 50) * 0.5) * DEG2RAD);
    this.fov = Math.min(165, Math.max(1, 2 * Math.atan(tanHalf * scaleRatio) * RAD2DEG));
    this.aspect = vpW / vpH;
    this.updateProjection();
    this.updateMatrixWorld();
    return this;
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.fov = source.fov;
    this.aspect = source.aspect;
    this.near = source.near;
    this.far = source.far;
    this.renderWidth = source.renderWidth ?? 1920;
    this.renderHeight = source.renderHeight ?? 1080;
    return this.updateProjection();
  }
}

export class OrthographicCamera extends Camera {
  constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 1000) {
    super();
    this.isOrthographicCamera = true;
    this.left = left; this.right = right; this.top = top; this.bottom = bottom; this.near = near; this.far = far;
    this.updateProjection();
  }
  updateProjection() {
    this.projectionMatrix.orthographic(this.left, this.right, this.top, this.bottom, this.near, this.far);
    return this;
  }
  updateProjectionMatrix() {
    return this.updateProjection();
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.left = source.left;
    this.right = source.right;
    this.top = source.top;
    this.bottom = source.bottom;
    this.near = source.near;
    this.far = source.far;
    return this.updateProjection();
  }
}
