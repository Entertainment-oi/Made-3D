import { Object3D } from '../core/Object3D.js';
import { Color } from '../math/Color.js';
import { Vec3 } from '../math/Vec3.js';

export class Light extends Object3D {
  constructor(color = 0xffffff, intensity = 1) {
    super();
    this.isLight = true;
    this.exportable = false;
    this.color = new Color(color);
    this.intensity = intensity;
    this.castShadow = false;    // proyecta sombras (solo las direccionales)
    this.shadow = null;          // ver DirectionalLight
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    if (source.color) this.color.copy(source.color);
    this.intensity = source.intensity ?? 1;
    return this;
  }
}

export class AmbientLight extends Light {
  constructor(color, intensity) { super(color, intensity); this.isAmbientLight = true; this.type = 'ambient'; }
}

export const SHADOW_RESOLUTIONS = [256, 512, 1024, 2048, 4096];
export const SHADOW_QUALITY = { low: 512, medium: 1024, high: 2048, ultra: 4096 };

// Ilumina desde su posición hacia `target` (máx. 4 por escena).
export class DirectionalLight extends Light {
  constructor(color, intensity) {
    super(color, intensity);
    this.isDirectionalLight = true;
    this.type = 'directional';
    this.target = new Vec3(0, 0, 0);
    this.position.set(1, 2, 3);
    // Sombras: mapa de profundidad con una cámara ortográfica alrededor del objetivo.
    this.shadow = {
      mapSize: 1024,                                  // lado del mapa de sombras (píxeles: 256, 512, 1024, 2048, 4096)
      autoQuality: true,                              // escala automáticamente con renderer.setQuality()
      camera: null,                                   // { left, right, top, bottom, near, far } (null = automático)
      bias: 0.002,                                    // margen para que no aparezcan "acnes"
      radius: 1.25,                                   // radio de suavizado PCF en texels (0 = sin PCF extra)
      strength: 1,                                    // 0 = sin sombra · 1 = sombra completa
    };
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    if (source.target) this.target.copy(source.target);
    if (source.shadow) {
      this.shadow = {
        ...source.shadow,
        camera: source.shadow.camera ? { ...source.shadow.camera } : null,
      };
    }
    return this;
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
    this.isPointLight = true;
    this.type = 'point';
    this.distance = distance;   // 0 = sin alcance máximo
    this.decay = decay;
    this.position.set(0, 1, 0);
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.distance = source.distance ?? 0;
    this.decay = source.decay ?? 2;
    return this;
  }
}

/**
 * Luz direccional focal (SpotLight): ilumina en forma de cono desde su posición siguiendo su rotación (-Z local).
 */
export class SpotLight extends Light {
  constructor(color = 0xffffff, intensity = 14, distance = 18, angle = Math.PI / 6, penumbra = 0.3, decay = 2) {
    super(color, intensity);
    this.isSpotLight = true;
    this.type = 'spot';
    this.distance = distance;
    this.angle = angle;
    this.penumbra = penumbra;
    this.decay = decay;
    this.position.set(0, 0, 0);
    this.rotation.set(-Math.PI / 2, 0, 0);
  }
  copy(source, recursive = true) {
    super.copy(source, recursive);
    this.distance = source.distance ?? 18;
    this.angle = source.angle ?? Math.PI / 6;
    this.penumbra = source.penumbra ?? 0.3;
    this.decay = source.decay ?? 2;
    return this;
  }
}
