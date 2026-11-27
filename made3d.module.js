// Made3D — núcleo ligero (sin cargar cargadores, exportadores, modelado, esculpido, gizmos, texto ni video).
// Uso: import { Scene, PerspectiveCamera, Renderer, loadModule, ... } from './made3d.module.js';

export const VERSION = '0.1.0';

// math
export * from './src/math/utils.js';
export { Vec2, Vec2 as Vector2 } from './src/math/Vec2.js';
export { Vec3, Vec3 as Vector3 } from './src/math/Vec3.js';
export { Quat, Quat as Quaternion } from './src/math/Quat.js';
export { Euler } from './src/math/Euler.js';
export { Mat4, Mat4 as Matrix4 } from './src/math/Mat4.js';
export { Color } from './src/math/Color.js';

// core
export { EventEmitter } from './src/core/EventEmitter.js';
export { Clock } from './src/core/Clock.js';
export { HistoryManager, estimateCommandBytes } from './src/core/HistoryManager.js';
export { Object3D } from './src/core/Object3D.js';
export { Scene } from './src/core/Scene.js';
export { Fog, FogExp2 } from './src/core/Fog.js';
export { Raycaster } from './src/core/Raycaster.js';
export { computeBounds, computeSceneReference, autoScaleObject, resetAutoScale } from './src/core/autoScale.js';

// cámaras
export { Camera, PerspectiveCamera, OrthographicCamera } from './src/cameras/Camera.js';

// geometría base y primitivas
export { BufferAttribute } from './src/geometry/BufferAttribute.js';
export { Geometry, Geometry as BufferGeometry } from './src/geometry/Geometry.js';
export {
  BoxGeometry,
  PlaneGeometry,
  SphereGeometry,
  CylinderGeometry,
  ConeGeometry,
  CapsuleGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  CircleGeometry,
  RingGeometry,
  PyramidGeometry,
  PolyhedronGeometry,
  TetrahedronGeometry,
  OctahedronGeometry,
  DodecahedronGeometry,
  IcosahedronGeometry,
} from './src/geometry/primitives.js';

// materiales integrados y texturas
export { Material, ShaderMaterial } from './src/materials/Material.js';
export { SurfaceMaterial, BasicMaterial, StandardMaterial } from './src/materials/BuiltinMaterials.js';
export { Texture } from './src/textures/Texture.js';

// objetos base y luces
export { Mesh } from './src/objects/Mesh.js';
export { Light, AmbientLight, DirectionalLight, PointLight, SpotLight, SHADOW_RESOLUTIONS, SHADOW_QUALITY } from './src/lights/Lights.js';

// render base (WebGL2 síncrono + WebGPU bajo demanda vía Renderer.create)
export { Renderer, Renderer as WebGLRenderer, WebGPURenderer } from './src/render/Renderer.js';
export { Frustum } from './src/render/Frustum.js';
export { RenderTarget, RenderTargetTexture } from './src/render/RenderTarget.js';

// controles y picking
export { OrbitControls } from './src/controls/OrbitControls.js';
export { Picker } from './src/picking/Picker.js';

// ───────── Carga perezosa bajo demanda con import() ─────────
const _moduleRegistry = {
  loaders: () => import('./src/modules/loaders.js'),
  gltfLoader: () => import('./src/loaders/GLTFLoader.js'),
  objLoader: () => import('./src/loaders/OBJLoader.js'),
  ktx2Loader: () => import('./src/loaders/KTX2Loader.js'),
  dracoLoader: () => import('./src/loaders/DRACOLoader.js'),
  madeOptimize: () => import('./src/libs/made-optimize/made_optimize.js'),
  zipLoader: () => import('./src/loaders/ZipLoader.js'),
  exporters: () => import('./src/modules/exporters.js'),
  gltfExporter: () => import('./src/exporters/GLTFExporter.js'),
  objExporter: () => import('./src/exporters/OBJExporter.js'),
  modeling: () => import('./src/modules/modeling.js'),
  sculpt: () => import('./src/modules/sculpt.js'),
  paint: () => import('./src/modules/paint.js'),
  gizmo: () => import('./src/modules/gizmo.js'),
  animation: () => import('./src/modules/animation.js'),
  rigging: () => import('./src/modules/rigging.js'),
  helpers: () => import('./src/modules/helpers.js'),
  stylized: () => import('./src/modules/stylized.js'),
  environment: () => import('./src/modules/environment.js'),
  text: () => import('./src/modules/text.js'),
  video: () => import('./src/modules/video.js'),
  webgpu: () => import('./src/render/WebGPU/GPUBackend.js'),
};

const _moduleCache = new Map();

export const AVAILABLE_MODULES = Object.freeze(Object.keys(_moduleRegistry));

/**
 * Importa bajo demanda (con caché) un submódulo pesado de Made3D usando `import()`.
 * Ejemplo: `const { GLTFLoader } = await loadModule('gltfLoader');`
 */
export function loadModule(name) {
  const key = String(name || '').trim();
  const factory = _moduleRegistry[key];
  if (!factory) {
    throw new Error(`Made3D: submódulo desconocido "${name}". Disponibles: ${AVAILABLE_MODULES.join(', ')}`);
  }
  let pending = _moduleCache.get(key);
  if (!pending) {
    pending = factory().catch((err) => {
      _moduleCache.delete(key);
      throw err;
    });
    _moduleCache.set(key, pending);
  }
  return pending;
}

/**
 * Carga múltiples submódulos en paralelo y combina sus exportaciones en un solo objeto.
 */
export async function loadModules(names = []) {
  const list = Array.isArray(names) ? names : [names];
  const mods = await Promise.all(list.map((name) => loadModule(name)));
  return Object.assign({}, ...mods);
}

/**
 * Precarga en segundo plano los submódulos indicados sin bloquear.
 */
export function preloadModules(names = []) {
  const list = Array.isArray(names) ? names : [names];
  return Promise.all(list.map((name) => loadModule(name)));
}

export function getLoadedModules() {
  return Array.from(_moduleCache.keys());
}

export const loadLoaders = () => loadModule('loaders');
export const loadGLTFLoader = () => loadModule('gltfLoader');
export const loadOBJLoader = () => loadModule('objLoader');
export const loadKTX2Loader = () => loadModule('ktx2Loader');
export const loadDRACOLoader = () => loadModule('dracoLoader');
export const loadMadeOptimizeModule = () => loadModule('madeOptimize');
export const loadZipLoader = () => loadModule('zipLoader');

export const loadExporters = () => loadModule('exporters');
export const loadGLTFExporter = () => loadModule('gltfExporter');
export const loadOBJExporter = () => loadModule('objExporter');

export const loadModeling = () => loadModule('modeling');
export const loadSculpt = () => loadModule('sculpt');
export const loadPaint = () => loadModule('paint');
export const loadGizmo = () => loadModule('gizmo');
export const loadAnimation = () => loadModule('animation');
export const loadRigging = () => loadModule('rigging');
export const loadHelpers = () => loadModule('helpers');
export const loadStylizedMaterials = () => loadModule('stylized');
export const loadEnvironment = () => loadModule('environment');
export const loadTextGeometry = () => loadModule('text');
export const loadVideoRecorder = () => loadModule('video');
export const loadWebGPUBackend = () => loadModule('webgpu');
