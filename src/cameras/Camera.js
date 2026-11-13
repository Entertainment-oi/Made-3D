import { Object3D } from '../core/Object3D.js';
import { Mat4 } from '../math/Mat4.js';
import { DEG2RAD } from '../math/utils.js';

export class Camera extends Object3D {
  constructor() {
    super();
    this.isCamera = true;
    this.projectionMatrix = new Mat4();
    this.viewMatrix = new Mat4();
  }
  get matrixWorldInverse() { return this.viewMatrix; }
  updateViewMatrix() { this.viewMatrix.copyInverse(this.matrixWorld); }
}

export class PerspectiveCamera extends Camera {
  constructor(fov = 50, aspect = 1, near = 0.1, far = 1000) {
    super();
    this.fov = fov; this.aspect = aspect; this.near = near; this.far = far;
    this.updateProjection();
  }
  updateProjection() {
    this.projectionMatrix.perspective(this.fov * DEG2RAD, this.aspect, this.near, this.far);
    return this;
  }
}

export class OrthographicCamera extends Camera {
  constructor(left = -1, right = 1, top = 1, bottom = -1, near = 0.1, far = 1000) {
    super();
    this.left = left; this.right = right; this.top = top; this.bottom = bottom; this.near = near; this.far = far;
    this.updateProjection();
  }
  updateProjection() {
    this.projectionMatrix.orthographic(this.left, this.right, this.top, this.bottom, this.near, this.far);
    return this;
  }
}
