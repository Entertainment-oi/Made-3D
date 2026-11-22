import { Material } from './Material.js';
import { BasicMaterial, StandardMaterial } from './BuiltinMaterials.js';
import {
  ToonMaterial,
  HologramMaterial,
  MatcapMaterial,
  FresnelMaterial,
  DissolveMaterial,
} from './StylizedMaterials.js';

/**
 * Convierte o clona un material a otro tipo integrado de Made3D conservando
 * sus propiedades comunes y parámetros de shader compatibles.
 */
export function convertMaterial(mat, targetType = null, overrides = {}) {
  if (!mat) return new StandardMaterial({ color: 0x4f86f7, ...overrides });
  const rawType = targetType || mat.type || 'standard';
  const type = String(rawType).replace(/Material$/i, '').toLowerCase();
  if (!targetType || type === String(mat.type || '').toLowerCase()) {
    if (typeof mat.clone === 'function') {
      return mat.clone(overrides);
    }
  }

  const baseShininess = typeof mat.getShininess === 'function' ? mat.getShininess() : mat.shininess;
  const opacity = overrides.opacity ?? mat.opacity ?? 1;
  const transparent = overrides.transparent !== undefined
    ? Boolean(overrides.transparent)
    : type === 'hologram'
      ? true
      : Boolean(mat.transparent || opacity < 0.999);

  const baseOpts = {
    name: mat.name ?? '',
    visible: mat.visible !== false,
    color: mat.color ? mat.color.getHex() : 0xffffff,
    shininess:
      baseShininess !== undefined
        ? baseShininess
        : type === 'toon'
        ? 48
        : type === 'dissolve'
        ? 32
        : 36,
    specular: mat.specular ?? 1,
    opacity,
    transparent,
    depthWrite: mat._depthWrite,
    blending: mat.blending ?? 'normal',
    twoPass: mat.twoPass ?? true,
    frustumCulled: mat.frustumCulled ?? true,
    fog: mat.fog ?? true,
    receiveShadow: mat.receiveShadow ?? true,
    alphaTest: mat.alphaTest ?? 0,
    wireframe: Boolean(mat.wireframe),
    vertexColors: Boolean(mat.vertexColors),
    side: type === 'hologram' || type === 'dissolve' ? 'double' : mat.side || 'front',
    map: mat.map || null,
  };

  let created;
  if (type === 'basic') {
    created = new BasicMaterial({ ...baseOpts, ...overrides });
  } else if (type === 'toon') {
    created = new ToonMaterial({
      ...baseOpts,
      steps: mat.steps ?? 3,
      smoothness: mat.smoothness ?? 0.06,
      shadowColor: mat.shadowColor ? mat.shadowColor.getHex() : 0x4b4a7a,
      shadowTint: mat.shadowTint ?? 0.45,
      rimColor: mat.rimColor ? mat.rimColor.getHex() : 0xffffff,
      rimPower: mat.rimPower ?? 3.5,
      rimStrength: mat.rimStrength ?? 0.7,
      inkColor: mat.inkColor ? mat.inkColor.getHex() : 0x111522,
      inkWidth: mat.inkWidth ?? 0.22,
      ...overrides,
    });
  } else if (type === 'hologram') {
    created = new HologramMaterial({
      ...baseOpts,
      transparent: true,
      depthWrite: false,
      blending: mat.type === 'hologram' ? mat.blending : 'additive',
      stripeColor: mat.stripeColor ? mat.stripeColor.getHex() : 0x7dd3fc,
      fresnelPower: mat.fresnelPower ?? 2.2,
      scanlineDensity: mat.scanlineDensity ?? 18.0,
      scanlineSpeed: mat.scanlineSpeed ?? 2.4,
      glitchStrength: mat.glitchStrength ?? 0.35,
      ...overrides,
    });
  } else if (type === 'matcap') {
    created = new MatcapMaterial({
      ...baseOpts,
      matcap: mat.matcap || null,
      rimColor: mat.rimColor ? mat.rimColor.getHex() : 0xdbeafe,
      glossiness: mat.glossiness ?? 0.55,
      metalness: mat.metalness ?? 0.25,
      ...overrides,
    });
  } else if (type === 'fresnel') {
    created = new FresnelMaterial({
      ...baseOpts,
      rimColor: mat.rimColor ? mat.rimColor.getHex() : 0x38bdf8,
      fresnelPower: mat.fresnelPower ?? 2.6,
      fresnelIntensity: mat.fresnelIntensity ?? 1.6,
      iridescence: mat.iridescence ?? 0.55,
      pulseSpeed: mat.pulseSpeed ?? 1.8,
      ...overrides,
    });
  } else if (type === 'dissolve') {
    created = new DissolveMaterial({
      ...baseOpts,
      progress: mat.progress ?? 0.35,
      autoAnimate: mat.autoAnimate ?? true,
      speed: mat.speed ?? 0.45,
      edgeColor: mat.edgeColor ? mat.edgeColor.getHex() : 0xff5a1f,
      edgeWidth: mat.edgeWidth ?? 0.09,
      noiseScale: mat.noiseScale ?? 3.8,
      ...overrides,
    });
  } else {
    const stdOpts = {
      ...baseOpts,
      emissive: mat.emissive ? mat.emissive.getHex() : 0x000000,
      normalMap: mat.normalMap || null,
      normalScale: mat.normalScale ? { x: mat.normalScale.x, y: mat.normalScale.y } : 1,
      emissiveMap: mat.emissiveMap || null,
      aoMap: mat.aoMap || null,
      aoMapIntensity: mat.aoMapIntensity ?? 1,
      envMapIntensity: mat.envMapIntensity ?? 1,
      metallicRoughnessMap: mat.metallicRoughnessMap || null,
      roughnessMap: mat.roughnessMap || null,
      metalnessMap: mat.metalnessMap || null,
    };
    if (mat.hasPbr) {
      stdOpts.hasPbr = true;
      stdOpts.roughness = mat.roughness ?? 1;
      stdOpts.metalness = mat.metalness ?? 0;
      delete stdOpts.shininess;
    }
    const merged = { ...stdOpts, ...overrides };
    if (overrides.shininess !== undefined && overrides.roughness === undefined) {
      delete merged.roughness;
    }
    created = new StandardMaterial(merged);
  }

  return created;
}

/**
 * Cambia el tipo de material de todas las mallas de un objeto (o subárbol)
 * compartiendo las instancias convertidas cuando dos mallas usaban el mismo material.
 */
export function applyMaterialType(root, targetType, overrides = {}) {
  if (!root || !root.traverse) return root;
  const cache = new Map();
  root.traverse((node) => {
    if (!node.isMesh || !node.material) return;
    if (Array.isArray(node.material)) {
      node.material = node.material.map((m) => {
        if (!m) return m;
        let next = cache.get(m);
        if (!next) {
          next = convertMaterial(m, targetType, overrides);
          cache.set(m, next);
        }
        return next;
      });
      return;
    }
    let nextMat = cache.get(node.material);
    if (!nextMat) {
      nextMat = convertMaterial(node.material, targetType, overrides);
      cache.set(node.material, nextMat);
    }
    node.material = nextMat;
  });
  return root;
}

Material.prototype.convertTo = function (targetType, overrides = {}) {
  return convertMaterial(this, targetType, overrides);
};
