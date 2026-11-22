import { GizmoBase } from './GizmoBase.js';

/**
 * GizmoClassic — el gizmo clásico de Made3D (una flecha por eje, planos, anillos y anillo exterior de pantalla),
 * ahora dibujado en canvas 2D como GizmoMade3d y con lo mismo que él: oculta los ejes vistos de punta,
 * orienta cada eje hacia el lado que ve la cámara, contorno naranja de selección, varios objetos, huesos, undo/redo y snap.
 * `size` es fracción de la altura de pantalla (0.15 por defecto); si pasas un valor > 1 se toma como píxeles.
 */
export class GizmoClassic extends GizmoBase {
  static SIZE = 0.15;
  static LOOK = {
    bothSides: false, arrowA: 0.1, arrowB: 0.8, scaleB: 0.82,
    dotT: 14, dotS: 16, dotRing: false,
    quad: [0.32, 0.52], squad: [0.22, 0.38], quadFill: 0.35,
    line: 2.2, lineHot: 3.4, ring: 1.8, ringHot: 3, head: 10, box: 5,
    glow: 0, glowHot: 8,
    ringR: 1, viewR: 1.18, viewC: '#ffffff', viewF: 0.6,
  };
}
