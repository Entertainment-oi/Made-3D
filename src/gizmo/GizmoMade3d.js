import { GizmoBase } from './GizmoBase.js';

/**
 * GizmoMade3d — el gizmo de la librería. Dibujado en un canvas 2D (no son modelos 3D):
 * líneas finas con brillo, flechas en los dos sentidos (±), anillos con arco de ángulo y lectura numérica.
 * Oculta las flechas que apuntan hacia atrás o directo a la cámara. Admite varios objetos y huesos.
 * Ver GizmoBase para la API completa (attach, setMode, setSnap, eventos, boneHelper...).
 */
export class GizmoMade3d extends GizmoBase {
  static SIZE = 120;   // píxeles
  static LOOK = {
    bothSides: true, arrowA: 0.22, arrowB: 1, scaleB: 0.85,
    dotT: 12, dotS: 15, dotRing: true,
    quad: [0.3, 0.6], squad: [0.3, 0.55], quadFill: 0.3,
    line: 3, lineHot: 4.5, ring: 2.6, ringHot: 4, head: 12, box: 6,
    glow: 4, glowHot: 14,
    ringR: 0.85, viewR: 1.08, viewC: '#cfd6e4', viewF: 1,
  };
}
