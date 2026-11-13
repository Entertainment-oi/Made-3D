import { Object3D } from '../core/Object3D.js';
import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';

export class Light extends Object3D {
  constructor(color = 0xffffff, intensity = 1) {
    super();
    this.isLight = true;
    this.color = new Color(color);
    this.intensity = intensity;
    this.castShadow = false;    // proyecta sombras (solo las direccionales)
    this.shadow = null;          // ver DirectionalLight
  }
}

export class AmbientLight extends Light {
  constructor(color, intensity) { super(color, intensity); this.type = 'ambient'; }
}

// Ilumina desde su posición hacia `target` (máx. 4 por escena).
export class DirectionalLight extends Light {
  constructor(color, intensity) {
    super(color, intensity);
    this.type = 'directional';
    this.target = new Vec3(0, 0, 0);
    this.position.set(1, 2, 3);
    // Sombras: mapa de profundidad con una cámara ortográfica alrededor del objetivo.
    this.shadow = {
      mapSize: 1024,                                  // lado del mapa de sombras (píxeles)
      camera: null,                                   // { left, right, top, bottom, near, far } (null = automático)
      bias: 0.002,                                    // margen para que no aparezcan "acnes"
      strength: 1,                                    // 0 = sin sombra · 1 = sombra completa
    };
  }
}

/**
 * Luz puntual: ilumina desde su posición con caída de intensidad.
 *
 *   const luz = new PointLight('#ffd9a0', 20, 0, 2);   // color, intensidad, alcance, caída
 *
 * Con `decay = 2` (por defecto) la intensidad cae con el cuadrado de la distancia: a 3 unidades
 * una intensidad de 20 aporta 20/9 ≈ 2.2. Con `decay = 0` la luz no decae (como las direccionales).
 * Si `distance > 0`, la luz se apaga a partir de esa distancia.
 */
export class PointLight extends Light {
  constructor(color = 0xffffff, intensity = 1, distance = 0, decay = 2) {
    super(color, intensity);
    this.type = 'point';
    this.distance = distance;   // 0 = sin alcance máximo
    this.decay = decay;
    this.position.set(0, 1, 0);
  }
}
