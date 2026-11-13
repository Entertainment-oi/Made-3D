import { Color } from '../math/Color.js';

/**
 * Niebla lineal: entre `near` y `far` el color se va mezclando con `color`.
 *
 *   scene.fog = new Fog('#14141c', 8, 40);
 */
export class Fog {
  constructor(color = 0xffffff, near = 1, far = 1000) {
    this.isFog = true;
    this.color = new Color(color);
    this.near = near;
    this.far = far;
    this.density = 0;    // 0 = niebla lineal
  }
}

// Niebla exponencial: sedensea con la distancia (no tiene near/far).
export class FogExp2 {
  constructor(color = 0xffffff, density = 0.01) {
    this.isFog = true;
    this.color = new Color(color);
    this.density = density;
    this.near = 0;
    this.far = 0;
  }
}
