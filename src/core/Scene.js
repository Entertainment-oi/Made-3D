import { Object3D } from './Object3D.js';
import { autoScaleObject, computeSceneReference } from './autoScale.js';

export class Scene extends Object3D {
  constructor(opts = {}) {
    super();
    this.isScene = true;
    this.background = null; // Color o null (usa el color de limpieza del renderer)
    this.fog = null;        // Fog o FogExp2 (o null: sin niebla)
    this.environment = opts.environment ?? null;
    this.environmentIntensity = opts.environmentIntensity ?? 1.0;
    this.environmentPreset = opts.environmentPreset ?? 'none';
    this.autoScaleOptions = {
      mode: 'smart',
      centerXZ: false,
      alignBottom: true,
      ...(typeof opts.autoScale === 'object' && opts.autoScale ? opts.autoScale : (opts.autoScaleOptions || {})),
    };
  }

  getReferenceSize(exclude = null, opts = {}) {
    return computeSceneReference(this, exclude, { ...this.autoScaleOptions, ...opts });
  }

  fitObject(obj, opts = {}) {
    return autoScaleObject(obj, { ...this.autoScaleOptions, ...opts, scene: this });
  }

  // Composición explícita: ajusta el tamaño del objeto respecto a la escena y luego lo añade.
  addFitted(obj, opts = {}) {
    if (!obj || obj === this) return this;
    this.fitObject(obj, opts);
    return this.add(obj);
  }

  // Devuelve los nodos raíz exportables de la escena según el contrato `isExportable()`.
  getExportables(opts = {}) {
    const onlyVisible = opts.onlyVisible !== undefined ? !!opts.onlyVisible : true;
    const out = [];
    for (const child of this.children) {
      if (!child) continue;
      if (onlyVisible && !child.visible) continue;
      if (child.isExportable ? !child.isExportable() : child.exportable === false) continue;
      out.push(child);
    }
    return out;
  }

  invalidateMaterials() {
    this.traverse((o) => {
      const m = o.material;
      if (Array.isArray(m)) {
        for (let i = 0; i < m.length; i++) m[i]?.invalidate?.();
      } else if (m?.invalidate) {
        m.invalidate();
      }
    });
    return this;
  }

  add(...objs) {
    return super.add(...objs);
  }
}
