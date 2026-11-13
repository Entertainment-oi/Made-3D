import { Object3D } from './Object3D.js';
import { autoScaleObject, computeSceneReference } from './autoScale.js';

export class Scene extends Object3D {
  constructor(opts = {}) {
    super();
    this.isScene = true;
    this.background = null; // Color o null (usa el color de limpieza del renderer)
    this.fog = null;        // Fog o FogExp2 (o null: sin niebla)
    this.autoScale = typeof opts.autoScale === 'object' ? opts.autoScale.enabled !== false : !!opts.autoScale;
    this.autoScaleOptions = {
      mode: 'smart',
      centerXZ: false,
      alignBottom: true,
      ...(typeof opts.autoScale === 'object' && opts.autoScale ? opts.autoScale : (opts.autoScaleOptions || {})),
    };
  }

  setAutoScale(enabled, opts = {}) {
    if (typeof enabled === 'object' && enabled !== null) {
      this.autoScale = enabled.enabled !== false;
      this.autoScaleOptions = { ...this.autoScaleOptions, ...enabled };
    } else {
      this.autoScale = !!enabled;
      if (opts && typeof opts === 'object') this.autoScaleOptions = { ...this.autoScaleOptions, ...opts };
    }
    return this;
  }

  getReferenceSize(exclude = null, opts = {}) {
    return computeSceneReference(this, exclude, { ...this.autoScaleOptions, ...opts });
  }

  fitObject(obj, opts = {}) {
    return autoScaleObject(obj, { ...this.autoScaleOptions, ...opts, scene: this });
  }

  add(...objs) {
    super.add(...objs);
    if (this.autoScale) {
      for (const o of objs) {
        if (!o || o === this) continue;
        this.fitObject(o);
      }
    }
    return this;
  }
}
