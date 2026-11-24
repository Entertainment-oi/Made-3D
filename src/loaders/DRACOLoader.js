import { Geometry } from '../geometry/Geometry.js';
import { decodeDraco, loadMadeOptimize } from '../libs/made-optimize/made_optimize.js';

const GLTF_TO_MADE3D_ATTR = {
  POSITION: 'position',
  NORMAL: 'normal',
  TEXCOORD_0: 'uv',
  TEXCOORD_1: 'uv1',
  COLOR_0: 'color',
  JOINTS_0: 'skinIndex',
  WEIGHTS_0: 'skinWeight',
};

const DRACO_ATTR_TYPE_TO_MADE3D = {
  0: 'position',
  1: 'normal',
  2: 'color',
  3: 'uv',
};

function buildGeometryFromMadeOptimize(decoded, attributeMap) {
  const geo = new Geometry();
  if (decoded.indices && decoded.indices.length > 0) {
    geo.setIndex(decoded.indices);
  }

  if (attributeMap) {
    const byUniqueId = new Map(decoded.attributes.map((a) => [a.uniqueId, a]));
    for (const [gltfName, uniqueId] of Object.entries(attributeMap)) {
      const targetName = GLTF_TO_MADE3D_ATTR[gltfName];
      if (!targetName) continue;
      const attr = byUniqueId.get(uniqueId);
      if (attr) geo.setAttribute(targetName, attr.array, attr.itemSize);
    }
  } else {
    let seenUv = false;
    for (const attr of decoded.attributes) {
      let targetName = DRACO_ATTR_TYPE_TO_MADE3D[attr.attrType];
      if (targetName === 'uv') {
        if (seenUv) targetName = 'uv1';
        seenUv = true;
      }
      if (targetName && !geo.attributes[targetName]) {
        geo.setAttribute(targetName, attr.array, attr.itemSize);
      }
    }
  }

  return geo;
}

/**
 * Decodificador de geometrías Draco (`KHR_draco_mesh_compression` y archivos `.drc`).
 * Impulsado 100% por `MadeOptimize` (`made_optimize.wasm`) escrito en Rust.
 */
export class DRACOLoader {
  constructor(opts = {}) {
    this.madeOptimizeUrl = opts.madeOptimizeUrl || undefined;
  }

  setDecoderPath() {
    return this;
  }

  preload() {
    return loadMadeOptimize(this.madeOptimizeUrl);
  }

  /**
   * Decodifica un buffer Draco asociado a una primitiva glTF (`KHR_draco_mesh_compression`)
   * o un archivo `.drc` independiente.
   * `attributeMap`: `{ POSITION: uniqueId, NORMAL: uniqueId, ... }`
   * `accessorsInfo`: `{ POSITION: accessorDef, ... }` (opcional, para normalización exacta).
   */
  async decodeGeometry(data, attributeMap = null, accessorsInfo = {}) {
    const decoded = await decodeDraco(data, attributeMap, accessorsInfo, this.madeOptimizeUrl);
    return buildGeometryFromMadeOptimize(decoded, attributeMap);
  }
}
