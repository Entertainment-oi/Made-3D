# Made3D (`v0.1.0`)

Motor ligero de gráficos **3D con doble backend WebGPU + WebGL2** escrito íntegramente en JavaScript puro (**ES Modules**, sin dependencias obligatorias de ejecución) con API familiar estilo Three.js y editor visual adaptable a **portátil y móvil**.

Comparte exactamente la misma escena (`Scene`, `Mesh`, `Camera`, `Geometry`, `Material`, entorno HDRI/IBL, luces, esqueletos y animaciones) entre **WebGL2** y **WebGPU**, e incluye renderizado PBR GGX con mapas de rugosidad/metalicidad/normales/AO/emisivo e iluminación por entorno (IBL), sombras direccionales PCF, materiales estilizados duales (GLSL + WGSL), instanciación por chunks con LOD, modelado poligonal interactivo (extrusión, biselado, puente/relleno, corte cuchillo/bucle, fusión por distancia, dureza por arista y Catmull-Clark), esculpido 3D con pinceles y simetría, contorno de selección en GPU, gizmos con historial deshacer/rehacer, animación por keyframes, picking de mallas y huesos, grabación de video WebM/MP4 con WebCodecs/MediaRecorder, y cargadores/exportadores de **glTF/GLB**, **OBJ/MTL**, **KTX2**, **Draco**, **RGBE (.hdr)** y **ZIP**.

---

## Tabla de contenidos

1. [Requisitos, ES Modules, Vite y Pruebas](#requisitos-es-modules-vite-y-pruebas)
2. [Arquitectura modular, carga perezosa (`import()`) y punto de entrada `full`](#arquitectura-modular-carga-perezosa-import-y-punto-de-entrada-full)
3. [Inicio rápido (`VERSION`, WebGL2 y WebGPU)](#inicio-rápido)
4. [Estructura del repositorio](#estructura-del-repositorio)
5. [Matemáticas y Utilidades](#matemáticas-y-utilidades)
6. [Núcleo, Escena, Niebla, Raycasting y Auto-escala](#núcleo-escena-niebla-raycasting-y-auto-escala)
7. [Cámaras y Frustum](#cámaras-y-frustum)
8. [Geometría, Primitivas y Texto 3D](#geometría-primitivas-y-texto-3d)
9. [Materiales, PBR, Shaders, Texturas e IBL/HDRI](#materiales-pbr-shaders-texturas-e-iblhdri)
10. [Objetos, Instanciación, Luces, Rigging y Esqueletos](#objetos-instanciación-luces-rigging-y-esqueletos)
11. [Animación por Keyframes](#animación-por-keyframes)
12. [Renderizado, RenderTargets y Grabación de Video](#renderizado-rendertargets-y-grabación-de-video)
13. [Controles, Picking, Gizmos y Contorno GPU](#controles-picking-gizmos-y-contorno-gpu)
14. [Esculpido Orgánico 3D](#esculpido-orgánico-3d)
15. [Modelado Poligonal y Subdivisión Suave (`EditableMesh`, `MeshEditor`, `SubdivisionSurface`)](#modelado-poligonal-y-subdivisión-suave)
16. [Cargadores y Exportadores (glTF, OBJ, KTX2, Draco, ZIP)](#cargadores-y-exportadores)
17. [Editor visual (Portátil y Móvil)](#editor-visual-portátil-y-móvil)

---

## Requisitos, ES Modules, Vite y Pruebas

Made3D está implementado íntegramente con **ES Modules** nativos (`import` / `export`).

### Ejecutar código fuera del navegador (Node.js) o en navegador

- **En navegador**: Usa siempre `<script type="module" src="./tu-app.js"></script>` y sírvelo mediante un servidor HTTP local (por ejemplo Vite), nunca desde `file://`.
- **En Node.js (`v18+` / `v22+`)**: El paquete raíz define `"type": "module"` en `package.json`. Las capas de matemáticas, escena, geometría, esqueletos, animación, raycasting, modelado poligonal (`EditableMesh`, `catmullClark`), `parseRGBE`, `ZipLoader`, `OBJLoader`, `OBJExporter` y `GLTFExporter` funcionan directamente en Node.js:

```bash
node --input-type=module -e "import { VERSION, Scene, Color } from './made3d.module.js'; const s = new Scene(); s.background = new Color(0x0e0f12); console.log(VERSION, s.background.getHexString());"
```

### Scripts disponibles (`package.json`)

```bash
npm install        # instala dependencias de desarrollo (Vite, Express, dotenv, esbuild)
npm run dev        # inicia el servidor de desarrollo en http://localhost:3000
npm run build      # compila el bundle en dist/
npm run preview    # previsualiza el build compilado de dist/
npm run lint       # valida sintaxis JS en src/, editor/, app.js, made3d.module.js y made3d.full.js
npm test           # ejecuta la suite automatizada en tests/*.test.js
```

---

## Arquitectura modular, carga perezosa (`import()`) y punto de entrada `full`

Made3D está diseñado para no obligar a tu sitio web a descargar todo el motor (decoders WASM, exportadores, esculpido, Catmull-Clark, WebGPU o grabador de video) si solo necesitas mostrar una escena 3D. Puedes consumir la librería de **tres maneras**:

### 1. Núcleo ligero + carga bajo demanda con `import()` (`./made3d.module.js`)

Al importar desde `./made3d.module.js`, solo se cargan síncronamente las piezas esenciales:
- `VERSION`, matemáticas (`Vec2`, `Vec3`, `Quat`, `Euler`, `Mat4`, `Color`, `DEG2RAD`, `RAD2DEG`, `clamp`, `lerp`)
- Núcleo (`EventEmitter`, `Clock`, `Object3D`, `Scene`, `Fog`, `FogExp2`, `Raycaster`, `autoScale`)
- Cámaras (`Camera`, `PerspectiveCamera`, `OrthographicCamera`)
- Geometría base y 16 primitivas (`BufferAttribute`, `Geometry`/`BufferGeometry`, `BoxGeometry`, `SphereGeometry`, etc.)
- Materiales integrados y texturas (`Material`, `ShaderMaterial`, `SurfaceMaterial`, `BasicMaterial`, `StandardMaterial`, `Texture`)
- Mallas, luces, controles, picking y renderer base (`Mesh`, `Light`, `AmbientLight`, `DirectionalLight`, `PointLight`, `Renderer`/`WebGLRenderer`/`WebGPURenderer`, `Frustum`, `RenderTarget`, `RenderTargetTexture`, `OrbitControls`, `Picker`)

Todo lo pesado se carga **bajo demanda** mediante `import()` dinámico (con caché automática de promesas):

```js
import {
  Scene,
  PerspectiveCamera,
  Renderer,
  loadModule,
  loadModules,
  preloadModules,
  getLoadedModules,
  AVAILABLE_MODULES,
  loadGLTFLoader,
  loadAnimation,
  loadEnvironment,
} from './made3d.module.js';

console.log('Submódulos disponibles:', AVAILABLE_MODULES);
console.log('Cargados al inicio:', getLoadedModules()); // []

// Cargar un submódulo concreto cuando se necesite:
const { GLTFLoader } = await loadGLTFLoader(); // equivalente a loadModule('gltfLoader')

// Cargar varios submódulos en paralelo y fusionar sus exportaciones:
const { AnimationMixer, createProceduralEnvironment } = await loadModules([
  'animation',
  'environment',
]);

// Precarga opcional en segundo plano sin bloquear el arranque:
preloadModules(['exporters', 'gizmo']);
```

> Además, **`Renderer.create()`** importa `./src/render/WebGPU/GPUBackend.js` con `import()` únicamente si el navegador soporta WebGPU y se solicita `'auto'` o `'webgpu'`, y **`GLTFLoader`** importa `ZipLoader`, `KTX2Loader` (MadeTexture WASM), `DRACOLoader` (MadeOptimize WASM) y `MeshoptDecoder` únicamente si el modelo cargado usa ese formato o extensión.

#### Mapa de carga perezosa (`made3d.module.js`)

| Helper / Clave en `loadModule(...)` | Submódulo cargado con `import()` | Qué aporta |
| :--- | :--- | :--- |
| `loadLoaders()` / `'loaders'` | `src/modules/loaders.js` | `GLTFLoader`, `OBJLoader`, `KTX2Loader`, `DRACOLoader`, `ZipLoader`, `extractFilesFromDataTransfer` |
| `loadGLTFLoader()` / `'gltfLoader'` | `src/loaders/GLTFLoader.js` | `GLTFLoader` |
| `loadOBJLoader()` / `'objLoader'` | `src/loaders/OBJLoader.js` | `OBJLoader` |
| `loadKTX2Loader()` / `'ktx2Loader'` | `src/loaders/KTX2Loader.js` | `KTX2Loader` |
| `loadDRACOLoader()` / `'dracoLoader'` | `src/loaders/DRACOLoader.js` | `DRACOLoader` |
| `loadZipLoader()` / `'zipLoader'` | `src/loaders/ZipLoader.js` | `ZipLoader`, `extractFilesFromDataTransfer` |
| `loadExporters()` / `'exporters'` | `src/modules/exporters.js` | `GLTFExporter`, `OBJExporter` |
| `loadGLTFExporter()` / `'gltfExporter'` | `src/exporters/GLTFExporter.js` | `GLTFExporter` |
| `loadOBJExporter()` / `'objExporter'` | `src/exporters/OBJExporter.js` | `OBJExporter` |
| `loadModeling()` / `'modeling'` | `src/modules/modeling.js` | `EditableMesh`, `edgeKey`, `SubdivisionSurface`, `MeshEditor`, constantes `EDIT_*` |
| `loadSculpt()` / `'sculpt'` | `src/modules/sculpt.js` | `Sculptor`, `subdivideGeometry`, `prepareSculptGeometry`, `computeWeldedNormals`, `SCULPT_*` |
| `loadGizmo()` / `'gizmo'` | `src/modules/gizmo.js` | `GizmoBase`, `GizmoMade3d`, `GizmoClassic`, `SelectionOutline`, `drawLightsOverlay` |
| `loadAnimation()` / `'animation'` | `src/modules/animation.js` | `AnimationClip`, `KeyframeTrack`, `VectorKeyframeTrack`, `QuaternionKeyframeTrack`, `NumberArrayKeyframeTrack`, `AnimationMixer`, `AnimationAction` |
| `loadRigging()` / `'rigging'` | `src/modules/rigging.js` | `Bone`, `Skeleton`, `SkeletonHelper`, `collectRigFromTarget`, `SkinnedMesh`, `cloneSkinned`, `cloneObject` |
| `loadHelpers()` / `'helpers'` | `src/modules/helpers.js` | `GridHelper`, `CameraHelper`, `InstancedMesh`, `ChunkedInstances` |
| `loadStylizedMaterials()` / `'stylized'` | `src/modules/stylized.js` | `ToonMaterial`, `HologramMaterial`, `MatcapMaterial`, `FresnelMaterial`, `DissolveMaterial`, `convertMaterial`, `applyMaterialType` |
| `loadEnvironment()` / `'environment'` | `src/modules/environment.js` | `parseRGBE`, `computeIrradianceSH`, `createProceduralEnvironment`, `createEnvironmentFromImage`, `loadEnvironmentFromFile` |
| `loadTextGeometry()` / `'text'` | `src/modules/text.js` | `TextGeometry` |
| `loadVideoRecorder()` / `'video'` | `src/modules/video.js` | `VideoRecorder`, `pickVideoMimeType`, `getSupportedVideoFormats`, `patchWebmDuration`, `patchWebmBufferDuration` |
| `loadWebGPUBackend()` / `'webgpu'` | `src/render/WebGPU/GPUBackend.js` | `GPUBackend` (usado automáticamente por `Renderer.create`) |

### 2. Imports estáticos por submódulo (`src/modules/*.js` y `exports` en `package.json`)

Si tu bundler (Vite, Rollup, esbuild) prefiere imports estáticos para hacer *tree-shaking* o dividir chunks por ruta, puedes importar directamente el submódulo que necesites:

```js
import { Scene, PerspectiveCamera, Renderer } from './made3d.module.js';
import { createProceduralEnvironment } from './src/modules/environment.js';
import { AnimationClip, AnimationMixer } from './src/modules/animation.js';
import { GLTFLoader } from './src/modules/loaders.js';
```

Subrutas declaradas en `package.json` (`exports`):
- `.` → `./made3d.module.js` (núcleo + helpers `load*`)
- `./core` → `./src/modules/core.js`
- `./full` → `./made3d.full.js`
- `./loaders`, `./exporters`, `./modeling`, `./sculpt`, `./gizmo`, `./animation`, `./rigging`, `./helpers`, `./stylized`, `./environment`, `./text`, `./video` → `./src/modules/<submodulo>.js`

### 3. Punto de entrada completo opcional (`./made3d.full.js` o `./full`)

Si estás haciendo un prototipo rápido, un entorno donde no te importa el tamaño inicial o prefieres importar cualquier clase del motor desde un solo archivo de forma síncrona (como en versiones previas), usa **`made3d.full.js`**:

```js
import {
  Renderer,
  Scene,
  PerspectiveCamera,
  ToonMaterial,
  EditableMesh,
  Sculptor,
  GLTFLoader,
  createProceduralEnvironment,
} from './made3d.full.js'; // o 'made3d-studio/full' vía package.json exports
```

---

## Inicio rápido

Con `backend: 'auto'`, `Renderer.create()` inicializa **WebGPU** (cargando `GPUBackend` con `import()`) si el navegador lo soporta y cae automáticamente a **WebGL2** compartiendo la misma escena.

> **Importante**: `scene.background` inicia en `null` (usa `renderer.clearColor`). Asigna un `new Color(...)` si deseas definir un fondo desde la escena.

```js
import {
  VERSION,
  Renderer,
  Scene,
  Color,
  PerspectiveCamera,
  OrbitControls,
  BoxGeometry,
  StandardMaterial,
  Mesh,
  AmbientLight,
  DirectionalLight,
  Clock,
  loadEnvironment,
} from './made3d.module.js';

console.log('Made3D', VERSION); // '0.1.0'

const canvas = document.getElementById('viewport');
const renderer = await Renderer.create({
  canvas,
  backend: 'auto', // 'auto' | 'webgpu' | 'webgl2'
  quality: 'auto',
  antialias: true,
});
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
scene.background = new Color(0x0e0f12);

// Entorno IBL cargado bajo demanda (o importa desde './src/modules/environment.js')
const { createProceduralEnvironment } = await loadEnvironment();
scene.environment = createProceduralEnvironment('studio');
scene.environmentIntensity = 1.0;

const camera = new PerspectiveCamera(50, renderer.aspect, 0.1, 200);
camera.position.set(3, 2.4, 4.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new AmbientLight(0xffffff, 0.25));
const sun = new DirectionalLight(0xfff4e0, 2.4);
sun.position.set(5, 8, 5);
sun.castShadow = true;
scene.add(sun);

const cube = new Mesh(
  new BoxGeometry(1.2, 1.2, 1.2),
  new StandardMaterial({ color: 0xf59e0b, roughness: 0.3, metalness: 0.2 })
);
cube.castShadow = true;
cube.receiveShadow = true;
scene.add(cube);

const clock = new Clock();
function animate() {
  const dt = clock.getDelta();
  cube.rotation.y += dt * 0.8;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();
```

---

## Estructura del repositorio

```text
├── made3d.module.js          # Punto de entrada ligero del núcleo + loaders perezosos `import()` (VERSION = '0.1.0')
├── made3d.full.js            # Barril completo opcional (re-exporta núcleo + todos los submódulos)
├── index.html                # Shell del editor visual Made3D Studio (portátil + móvil)
├── style.css                 # Sistema de diseño oscuro 60-30-10 y layouts responsivos
├── app.js                    # Inicialización del editor
├── editor/                   # Controladores del editor visual
│   ├── store.js              # Estado compartido, preferencias y cámara activa
│   ├── dom.js                # Referencias centralizadas del DOM
│   ├── viewport.js           # Renderer, Picker, GizmoMade3d y ciclo de selección
│   ├── inspectorUI.js        # Panel inspector (desktop + bottom-sheet móvil) y comandos
│   ├── sceneActions.js       # Presets, iluminación, HDRI/IBL, importación y exportación
│   ├── editController.js     # Integración de MeshEditor y herramientas poligonales
│   ├── sculptController.js   # Integración de Sculptor y pinceles orgánicos
│   ├── cameraView.js         # Cámara de render, visor 16:9/4:3/1:1 y grabación WebM/MP4
│   ├── history.js            # Pila de deshacer / rehacer (Ctrl+Z / Ctrl+Y)
│   └── loop.js               # Bucle de renderizado, animación y FPS
├── src/                      # Motor 3D Made3D sin dependencias
│   ├── modules/              # Puntos de entrada modulares (loaders, exporters, modeling, sculpt, gizmo, animation, rigging, helpers, stylized, environment, text, video, core)
│   ├── math/                 # Vec2, Vec3, Quat, Euler, Mat4, Color, utils
│   ├── core/                 # Object3D, Scene, Clock, Fog, Raycaster, EventEmitter, autoScale
│   ├── cameras/              # Camera, PerspectiveCamera, OrthographicCamera
│   ├── geometry/             # BufferAttribute, Geometry, 16 primitivas, TextGeometry, triangulate
│   ├── materials/            # Material, ShaderMaterial, StandardMaterial (PBR), StylizedMaterials, convertMaterial
│   ├── textures/             # Texture, EnvironmentLoader (parseRGBE, SH, IBL procedural)
│   ├── objects/              # Mesh, InstancedMesh, ChunkedInstances, GridHelper, CameraHelper, Bone, Skeleton, SkinnedMesh, cloneSkinned
│   ├── lights/               # Light, AmbientLight, DirectionalLight, PointLight
│   ├── animation/            # AnimationClip, KeyframeTracks, AnimationMixer, AnimationAction
│   ├── loaders/              # GLTFLoader, OBJLoader, KTX2Loader, DRACOLoader, ZipLoader
│   ├── exporters/            # GLTFExporter, OBJExporter
│   ├── picking/              # Picker (mallas + huesos + instancias)
│   ├── render/               # Renderer, WebGPURenderer, RenderTarget, Frustum, VideoRecorder, VideoMuxer, WebGL2/, WebGPU/
│   ├── controls/             # OrbitControls
│   ├── gizmo/                # GizmoBase, GizmoMade3d, GizmoClassic, SelectionOutline
│   ├── modeling/             # EditableMesh, MeshEditor, MeshUnion, SubdivisionSurface
│   ├── sculpt/               # Sculptor y utilidades de subdivisión triangular
│   └── shaders/              # Programas GLSL (WebGL2) y WGSL (WebGPU)
└── tests/                    # Suite automatizada con node:test
    ├── core-animation-rigging.test.js
    ├── modeling.test.js
    ├── environment.test.js
    └── loaders-exporters.test.js
```

---

## Matemáticas y Utilidades

Todas las operaciones usan matemáticas in-place con encadenamiento de métodos. `Vector2`, `Vector3`, `Quaternion` y `Matrix4` se exportan como alias directos de `Vec2`, `Vec3`, `Quat` y `Mat4`.

### `DEG2RAD`, `RAD2DEG`, `clamp`, `lerp`

```js
import { DEG2RAD, RAD2DEG, clamp, lerp } from './made3d.module.js';

const rad = 45 * DEG2RAD;            // 0.785398...
const deg = Math.PI * RAD2DEG;       // 180
const val = clamp(1.4, 0, 1);        // 1
const mix = lerp(10, 20, 0.25);      // 12.5
```

### `Vec2` / `Vector2` y `Vec3` / `Vector3`

```js
import { Vec2, Vector2, Vec3, Vector3 } from './made3d.module.js';

const uv = new Vector2(0.5, 0.5).multiplyScalar(2);
const uv2 = new Vec2(1, 0).lerp(uv, 0.5);

const a = new Vec3(1, 2, 3);
const b = new Vector3(0, 1, 0);
const cross = new Vec3().crossVectors(a, b).normalize();
const dist = a.distanceTo(b);
```

### `Euler`, `Quat` / `Quaternion`, `Mat4` / `Matrix4`

```js
import { Euler, Quat, Quaternion, Mat4, Matrix4, Vec3, DEG2RAD } from './made3d.module.js';

const euler = new Euler(0, 90 * DEG2RAD, 0, 'XYZ');
const q = new Quaternion().setFromEuler(euler);
const qAxis = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI * 0.5);

const mat = new Matrix4().compose(new Vec3(1, 0, -2), q, new Vec3(1, 1, 1));
const matInv = new Mat4().copyInverse(mat);
```

### `Color`

```js
import { Color } from './made3d.module.js';

const c1 = new Color(0xf59e0b);
const c2 = new Color('#38bdf8');
c1.lerp(c2, 0.5);
console.log(c1.getHexString(), c1.toArray());
```

---

## Núcleo, Escena, Niebla, Raycasting y Auto-escala

### `EventEmitter` y `Clock`

```js
import { EventEmitter, Clock } from './made3d.module.js';

const bus = new EventEmitter();
const onReady = (payload) => console.log('Listo:', payload);
bus.on('ready', onReady);
bus.once('first-tick', (t) => console.log('Primer frame:', t));
bus.emit('ready', { ok: true });
bus.off('ready', onReady);

const clock = new Clock();
const dt = clock.getDelta();
const total = clock.getElapsedTime();
```

### `Object3D`, `Scene`, `Fog`, `FogExp2`

```js
import { Object3D, Scene, Fog, FogExp2, Color } from './made3d.module.js';

const scene = new Scene();
scene.background = new Color(0x111622);
scene.fog = new Fog(0x111622, 8, 35);        // niebla lineal (color, near, far)
// o exponencial: scene.fog = new FogExp2(0x111622, 0.045);

const group = new Object3D();
group.name = 'Torre';
group.position.set(0, 1.5, 0);
scene.add(group);
scene.traverse((node) => console.log(node.name));
```

### `Raycaster`

```js
import { Raycaster, Vec3 } from './made3d.module.js';

const raycaster = new Raycaster(new Vec3(0, 5, 0), new Vec3(0, -1, 0), 0.1, 100);
// O desde la cámara (coordenadas NDC -1..1):
// raycaster.setFromCamera({ x: 0, y: 0 }, camera);
const hits = raycaster.intersectObjects(scene.children, true);
if (hits.length) {
  console.log('Impacto:', hits[0].object.name, hits[0].distance, hits[0].point);
}
```

### `computeBounds`, `computeSceneReference`, `autoScaleObject`, `resetAutoScale`

Utilidades para medir AABB en espacio mundial, calcular el tamaño medio natural de una escena y normalizar modelos importados.

```js
import {
  computeBounds,
  computeSceneReference,
  autoScaleObject,
  resetAutoScale,
} from './made3d.module.js';

const bounds = computeBounds(modelo);
console.log(bounds.size, bounds.center, bounds.maxDim);

const ref = computeSceneReference(scene);
console.log('Tamaño de referencia:', ref.targetSize, 'suelo Y:', ref.groundY);

// Ajusta el modelo al tamaño de referencia de la escena y lo apoya sobre el suelo
autoScaleObject(modelo, { scene, mode: 'smart', alignBottom: true, centerXZ: true });

// Revertir a su escala y posición originales:
resetAutoScale(modelo);
```

---

## Cámaras y Frustum

### `Camera`, `PerspectiveCamera`, `OrthographicCamera`, `CameraHelper`, `Frustum`

```js
import {
  Camera,
  PerspectiveCamera,
  OrthographicCamera,
  Frustum,
  Mat4,
} from './made3d.module.js';
import { CameraHelper } from './src/modules/helpers.js'; // o await loadHelpers()

// Base genérica `Camera` disponible para cámaras personalizadas
const baseCam = new Camera();

const persp = new PerspectiveCamera(50, 16 / 9, 0.1, 150);
persp.position.set(4, 3, 6);
persp.lookAt(0, 0.5, 0);

// Cámara ortográfica (ideal para vistas técnicas o mapas de sombras)
const ortho = new OrthographicCamera(-5, 5, 5, -5, 0.1, 100);
ortho.position.set(0, 10, 0);
ortho.lookAt(0, 0, 0);

// Visualizador de frustum en escena
const renderCam = new PerspectiveCamera(35, 16 / 9, 0.2, 40);
const camHelper = new CameraHelper(renderCam);
scene.add(renderCam, camHelper);
camHelper.update();

// Culling manual con Frustum (proj * view)
const vp = new Mat4().multiplyMatrices(persp.projectionMatrix, persp.matrixWorldInverse);
const frustum = new Frustum().setFromMatrix(vp);
const visible = frustum.intersectsSphere(0, 0, 0, 1.0);
```

---

## Geometría, Primitivas y Texto 3D

### `BufferAttribute` y `Geometry` / `BufferGeometry`

```js
import { BufferAttribute, Geometry, BufferGeometry } from './made3d.module.js';

const geo = new Geometry(); // alias: new BufferGeometry()
const positions = new Float32Array([0, 1, 0,  -1, -1, 0,  1, -1, 0]);
geo.setAttribute('position', new BufferAttribute(positions, 3));
geo.setAttribute('uv', new Float32Array([0.5, 1,  0, 0,  1, 0]), 2);
geo.setIndex([0, 1, 2]);
geo.computeVertexNormals();
geo.computeBoundingSphere();
```

### Todas las primitivas 3D incluidas

```js
import {
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
} from './made3d.module.js';

const gBox      = new BoxGeometry(1, 1, 1, 2, 2, 2);
const gPlane    = new PlaneGeometry(4, 4, 8, 8);
const gSphere   = new SphereGeometry(0.8, 32, 24);
const gCyl      = new CylinderGeometry(0.5, 0.5, 1.5, 24, 1, false);
const gCone     = new ConeGeometry(0.6, 1.4, 24);
const gCapsule  = new CapsuleGeometry(0.4, 0.9, 8, 20);
const gTorus    = new TorusGeometry(0.7, 0.22, 16, 36);
const gKnot     = new TorusKnotGeometry(0.6, 0.16, 72, 12, 2, 3);
const gCircle   = new CircleGeometry(0.8, 32);
const gRing     = new RingGeometry(0.35, 0.8, 32, 1);
const gPyramid  = new PyramidGeometry(1.2, 1.2, 1.2);
const gTetra    = new TetrahedronGeometry(0.8, 0);
const gOcta     = new OctahedronGeometry(0.8, 0);
const gDodeca   = new DodecahedronGeometry(0.8, 0);
const gIcosa    = new IcosahedronGeometry(0.8, 1);

// Poliedro personalizado a partir de vértices e índices:
const gPoly = new PolyhedronGeometry(
  [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
  [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1],
  0.8,
  1
);
```

### `TextGeometry`

Extruye texto 2D con curvas Bézier/contornos con huecos internos en una malla 3D (con fuente bitmap de respaldo si corre en Node.js sin DOM).

```js
import { Mesh, StandardMaterial, loadTextGeometry } from './made3d.module.js';
// O importación estática directa: import { TextGeometry } from './src/modules/text.js';

const { TextGeometry } = await loadTextGeometry();
const textGeo = new TextGeometry('Made3D', {
  size: 0.8,
  depth: 0.2,
  fontWeight: '700',
  align: 'center',
  curveResolution: 72,
});
const titleMesh = new Mesh(textGeo, new StandardMaterial({ color: 0xf59e0b }));
// Actualizar texto dinámicamente:
textGeo.rebuild({ text: 'v0.1.0', depth: 0.25 });
```

---

## Materiales, PBR, Shaders, Texturas e IBL/HDRI

### `Material`, `SurfaceMaterial`, `BasicMaterial`, `StandardMaterial` (PBR completo)

```js
import {
  Material,
  SurfaceMaterial,
  BasicMaterial,
  StandardMaterial,
  Texture,
} from './made3d.module.js';

// Base mínima y superficie reutilizable para shaders propios
const baseMat = new Material({ side: 'front', transparent: false });
const customSurface = new SurfaceMaterial({ color: 0xffffff, shininess: 48 });

// Sin iluminación (ideal para fondos, UI 3D o guías)
const basicMat = new BasicMaterial({ color: 0x38bdf8, wireframe: false });

// PBR Cook-Torrance GGX completo compatible con IBL (WebGL2 + WebGPU)
const pbrMat = new StandardMaterial({
  color: 0xffffff,
  roughness: 0.28,
  metalness: 0.85,
  map: Texture.load('./albedo.png'),
  normalMap: Texture.load('./normal.png', { colorSpace: 'linear' }),
  metallicRoughnessMap: Texture.load('./orm.png', { colorSpace: 'linear' }),
  aoMap: Texture.load('./ao.png', { colorSpace: 'linear' }),
  aoMapIntensity: 1.0,
  emissive: 0x112244,
  emissiveIntensity: 0.8,
  envMapIntensity: 1.2,
});
```

### `ShaderMaterial` (GLSL + WGSL personalizados)

```js
import { ShaderMaterial, Color } from './made3d.module.js';

const shaderMat = new ShaderMaterial({
  uniforms: {
    uColor: new Color(0xf59e0b),
    uSpeed: 2.0,
  },
  vertexShader: /* glsl */ `
    in vec3 position;
    in vec3 normal;
    uniform mat4 uModel, uView, uProj;
    out vec3 vNormal;
    void main() {
      vNormal = mat3(uModel) * normal;
      gl_Position = uProj * uView * uModel * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform vec3 uColor;
    uniform float uTime, uSpeed;
    in vec3 vNormal;
    out vec4 fragColor;
    void main() {
      float pulse = 0.65 + 0.35 * sin(uTime * uSpeed + vNormal.y * 3.0);
      fragColor = vec4(uColor * pulse, 1.0);
    }
  `,
});
```

### Materiales Estilizados (`ToonMaterial`, `HologramMaterial`, `MatcapMaterial`, `FresnelMaterial`, `DissolveMaterial`)

Todos funcionan en WebGL2 y WebGPU de manera idéntica.

```js
import {
  ToonMaterial,
  HologramMaterial,
  MatcapMaterial,
  FresnelMaterial,
  DissolveMaterial,
} from './src/modules/stylized.js'; // o `await loadStylizedMaterials()` desde made3d.module.js

const toon = new ToonMaterial({
  color: 0x60a5fa,
  steps: 4,
  smoothness: 0.05,
  shadowColor: 0x1e293b,
  rimColor: 0xffffff,
  inkColor: 0x090d16,
  inkWidth: 0.2,
});

const holo = new HologramMaterial({
  color: 0x22d3ee,
  stripeColor: 0xa5f3fc,
  scanlineDensity: 20,
  scanlineSpeed: 2.5,
  glitchStrength: 0.35,
});

const matcap = new MatcapMaterial({
  color: 0xf8fafc,
  glossiness: 0.7,
  metalness: 0.35,
  matcap: null, // o Texture.load('./matcap.png')
});

const fresnel = new FresnelMaterial({
  color: 0x0f172a,
  rimColor: 0x38bdf8,
  fresnelPower: 2.6,
  fresnelIntensity: 1.6,
  iridescence: 0.55,
});

const dissolve = new DissolveMaterial({
  color: 0xf97316,
  edgeColor: 0xfacc15,
  progress: 0.35,
  autoAnimate: true,
  speed: 0.45,
});
```

### `convertMaterial`, `applyMaterialType` y `Material.prototype.convertTo`

```js
import { StandardMaterial } from './made3d.module.js';
import { convertMaterial, applyMaterialType } from './src/modules/stylized.js';

const std = new StandardMaterial({ color: 0xe11d48, roughness: 0.4 });
const asToon = convertMaterial(std, 'toon', { steps: 3 });
// Equivalente usando el método de instancia:
const asFresnel = std.convertTo('fresnel', { rimColor: 0xfacc15 });

// Convierte todos los materiales de una jerarquía manteniendo instancias compartidas:
applyMaterialType(personaje, 'toon', { steps: 4 });
```

### `Texture`

```js
import { Texture } from './made3d.module.js';

const albedo = Texture.load('./textura.png', { colorSpace: 'srgb', wrapS: 'repeat', wrapT: 'repeat' });
const checker = Texture.checkerboard({ size: 256, cells: 8 });
```

### IBL / HDRI (`parseRGBE`, `computeIrradianceSH`, `createProceduralEnvironment`, `createEnvironmentFromImage`, `loadEnvironmentFromFile`)

```js
import {
  parseRGBE,
  computeIrradianceSH,
  createProceduralEnvironment,
  createEnvironmentFromImage,
  loadEnvironmentFromFile,
} from './src/modules/environment.js'; // o `await loadEnvironment()` desde made3d.module.js

// 1) Presets procedurales listos para PBR/IBL: 'studio' | 'sunset' | 'outdoor' | 'warehouse'
scene.environment = createProceduralEnvironment('studio', 256, 128);
scene.environmentIntensity = 1.0;

// 2) Desde archivo .hdr (Radiance RGBE) o imagen LDR equirectangular (.png/.jpg/.webp)
async function onHdrSelected(file) {
  scene.environment = await loadEnvironmentFromFile(file);
}

// 3) Desde un ArrayBuffer .hdr directamente (funciona también en Node.js)
const envTex = parseRGBE(hdrArrayBuffer);

// 4) Desde un HTMLImageElement ya cargado
const envFromImg = createEnvironmentFromImage(imgElement, 'sky');

// 5) Armónicos esféricos L2 (36 floats = 9 vec4) a partir de buffer equirectangular Float32 RGBA
const sh = computeIrradianceSH(float32RgbaBuffer, 256, 128);
```

---

## Objetos, Instanciación, Luces, Rigging y Esqueletos

### `Mesh`, `GridHelper`, `InstancedMesh`, `ChunkedInstances`

```js
import {
  Mesh,
  BoxGeometry,
  StandardMaterial,
  Mat4,
  Vec3,
  Quat,
  Color,
} from './made3d.module.js';
import { GridHelper, InstancedMesh, ChunkedInstances } from './src/modules/helpers.js'; // o `await loadHelpers()`

const grid = new GridHelper(24, 24, 0x334155, 0x1e293b);
scene.add(grid);

// Instanciación clásica en una sola draw call
const boxGeo = new BoxGeometry(0.4, 0.4, 0.4);
const boxMat = new StandardMaterial({ color: 0xffffff });
const instances = new InstancedMesh(boxGeo, boxMat, 500);
const dummy = new Mat4();
for (let i = 0; i < 500; i++) {
  dummy.compose(new Vec3((i % 25) - 12, 0.2, Math.floor(i / 25) - 10), new Quat(), new Vec3(1, 1, 1));
  instances.setMatrixAt(i, dummy);
  instances.setColorAt(i, new Color().setHSL(i / 500, 0.75, 0.55));
}
instances.instanceMatrix.needsUpdate = true;
scene.add(instances);

// Instanciación espacial por chunks con Frustum Culling + LOD automático por distancia
const forest = new ChunkedInstances(boxGeo, boxMat, {
  chunkSize: 16,
  lod: [{ distance: 60, geometry: boxGeo }, { distance: 140, geometry: null }],
});
forest.addInstance(new Vec3(10, 0, 12), new Quat(), new Vec3(1, 2, 1));
forest.build();
scene.add(forest);
```

### Rigging: `Bone`, `Skeleton`, `SkinnedMesh`, `SkeletonHelper`, `collectRigFromTarget`, `cloneSkinned`, `cloneObject`

```js
import { CylinderGeometry, StandardMaterial } from './made3d.module.js';
import {
  Bone,
  Skeleton,
  SkinnedMesh,
  SkeletonHelper,
  collectRigFromTarget,
  cloneSkinned,
  cloneObject,
} from './src/modules/rigging.js'; // o `await loadRigging()`

const rootBone = new Bone();
rootBone.name = 'Hips';
const spineBone = new Bone();
spineBone.name = 'Spine';
spineBone.position.set(0, 1, 0);
rootBone.add(spineBone);

const skeleton = new Skeleton([rootBone, spineBone]);
const skinned = new SkinnedMesh(new CylinderGeometry(0.3, 0.3, 2, 12, 4), new StandardMaterial());
skinned.add(rootBone);
skinned.bind(skeleton);
scene.add(skinned);

// Helper visual del esqueleto e inspección de rig
const skelHelper = new SkeletonHelper(skinned);
scene.add(skelHelper);
const rig = collectRigFromTarget(skinned, scene);
console.log('Huesos encontrados:', rig.bones.length);

// Clonar personaje con esqueleto independiente o cualquier objeto/jerarquía
const cloneChar = cloneSkinned(skinned, { cloneMaterial: true });
const cloneAny = cloneObject(cube, { cloneMaterial: true });
```

### Luces y Sombras (`Light`, `AmbientLight`, `DirectionalLight`, `PointLight`, `SHADOW_RESOLUTIONS`, `SHADOW_QUALITY`)

```js
import {
  Light,
  AmbientLight,
  DirectionalLight,
  PointLight,
  SHADOW_RESOLUTIONS,
  SHADOW_QUALITY,
} from './made3d.module.js';

console.log('Resoluciones:', SHADOW_RESOLUTIONS, 'Calidades:', SHADOW_QUALITY);

const amb = new AmbientLight(0xffffff, 0.3);
const dir = new DirectionalLight(0xfff1dc, 2.2);
dir.position.set(6, 10, 4);
dir.castShadow = true;
dir.shadow.mapSize = SHADOW_QUALITY.high; // 2048

const point = new PointLight(0x38bdf8, 12, 10, 2);
point.position.set(-2, 2, 1);

scene.add(amb, dir, point);
```

---

## Animación por Keyframes

### `AnimationClip`, `KeyframeTrack`, `VectorKeyframeTrack`, `QuaternionKeyframeTrack`, `NumberArrayKeyframeTrack`, `AnimationMixer`, `AnimationAction`

```js
import {
  AnimationClip,
  KeyframeTrack,
  VectorKeyframeTrack,
  QuaternionKeyframeTrack,
  NumberArrayKeyframeTrack,
  AnimationMixer,
  AnimationAction,
} from './src/modules/animation.js'; // o `await loadAnimation()` desde made3d.module.js

const posTrack = new VectorKeyframeTrack(
  'Cubo.position',
  [0, 1, 2],
  [0, 0, 0,  0, 2, 0,  0, 0, 0]
);
const rotTrack = new QuaternionKeyframeTrack(
  'Cubo.quaternion',
  [0, 1, 2],
  [0, 0, 0, 1,  0, 0.707, 0, 0.707,  0, 0, 0, 1]
);
const weightTrack = new NumberArrayKeyframeTrack('Cubo.morphTargetInfluences', [0, 1], [0, 1]);
const genericTrack = new KeyframeTrack('Cubo.scale', [0, 1], [1, 1, 1, 1.5, 1.5, 1.5], 3);

const clip = new AnimationClip('Salto', 2.0, [posTrack, rotTrack, weightTrack, genericTrack]);
const mixer = new AnimationMixer(cube);
const action = mixer.clipAction(clip); // instancia de AnimationAction
action.setLoop('repeat').play();
// Verifica instancia: action instanceof AnimationAction === true

// En cada frame:
mixer.update(dt);
```

---

## Renderizado, RenderTargets y Grabación de Video

### `Renderer` / `WebGLRenderer`, `WebGPURenderer`

```js
import { Renderer, WebGLRenderer, WebGPURenderer } from './made3d.module.js';

// Detección automática (WebGPU con fallback a WebGL2)
const autoRenderer = await Renderer.create({ canvas, backend: 'auto', antialias: true });

// Forzar WebGL2 explícitamente
const glRenderer = new WebGLRenderer({ canvas, antialias: true });

// Forzar WebGPU explícitamente
const gpuRenderer = await WebGPURenderer.create({ canvas, antialias: true });

autoRenderer.setQuality('high');
```

### `RenderTarget` y `RenderTargetTexture`

Renderizado fuera de pantalla para reflejos, portales o pantallas dentro de la escena.

```js
import { RenderTarget, RenderTargetTexture, StandardMaterial } from './made3d.module.js';

const rt = new RenderTarget(512, 512, { depthBuffer: true, colorSpace: 'linear' });
// rt.texture es instancia de RenderTargetTexture
console.log(rt.texture instanceof RenderTargetTexture); // true

renderer.setRenderTarget(rt);
renderer.render(scene, securityCamera);
renderer.setRenderTarget(null);

const monitorMat = new StandardMaterial({ map: rt.texture });
```

### `VideoRecorder`, `pickVideoMimeType`, `getSupportedVideoFormats`, `patchWebmDuration`, `patchWebmBufferDuration`

`VideoRecorder` se carga bajo demanda para no penalizar el arranque inicial:

```js
import { loadVideoRecorder } from './made3d.module.js';
// O importación estática: import { VideoRecorder, getSupportedVideoFormats, ... } from './src/modules/video.js';

const { getSupportedVideoFormats, pickVideoMimeType } = await loadVideoRecorder();
console.log('Formatos soportados:', getSupportedVideoFormats());
console.log('MIME recomendado:', pickVideoMimeType('auto'));

// Forma recomendada: el renderer importa VideoRecorder automáticamente con import()
const recorder = await renderer.createVideoRecorderAsync(scene, renderCamera, 1920, 1080, {
  fps: 30,
  mode: 'realtime', // 'realtime' | 'fixed'
  format: 'auto',   // 'auto' | 'mp4' | 'webm'
});
await recorder.prepare();
recorder.start();
// En cada frame del loop:
recorder.captureFrame();

// Al terminar:
const result = await recorder.stop(); // { blob, mimeType, extension, duration, frames }

// Utilidades de duración WebM (cuando se usa MediaRecorder manualmente):
const { patchWebmDuration, patchWebmBufferDuration } = await loadVideoRecorder();
const fixedBlob = await patchWebmDuration(rawWebmBlob, 5000);
const patchedBytes = patchWebmBufferDuration(new Uint8Array(await rawWebmBlob.arrayBuffer()), 5000);
```

---

## Controles, Picking, Gizmos y Contorno GPU

### `OrbitControls` y `Picker`

```js
import { OrbitControls, Picker } from './made3d.module.js';

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const picker = new Picker(renderer.domElement, { prefer: 'bone', boneTolerance: 12 });
renderer.domElement.addEventListener('pointerdown', (e) => {
  const hit = picker.pick(e, camera, scene);
  if (hit) console.log(hit.type, hit.object.name);
});
```

### `GizmoBase`, `GizmoMade3d`, `GizmoClassic` y `SelectionOutline`

```js
import { GizmoBase, GizmoMade3d, GizmoClassic, SelectionOutline } from './src/modules/gizmo.js'; // o `await loadGizmo()`

// GizmoMade3d (moderno con anillos/asas táctiles) o GizmoClassic (ejes clásicos); ambos heredan de GizmoBase
const gizmo = new GizmoMade3d({ mode: 'translate', space: 'world' });
// o: const classic = new GizmoClassic({ mode: 'rotate' });
console.log(gizmo instanceof GizmoBase); // true

gizmo.attach({
  canvas: overlayCanvas,
  camera,
  controls,
  picker,
  scene,
  onSelect: (obj) => outline.setTarget(obj),
});

// Contorno de selección en GPU (compatible con WebGL2 y WebGPU)
const outline = new SelectionOutline({ color: 0xf59e0b, thickness: 2 });
```

---

## Esculpido Orgánico 3D

### `Sculptor`, `subdivideGeometry`, `prepareSculptGeometry`, `computeWeldedNormals`, `SCULPT_TOOLS`, `SCULPT_SYMMETRIES`, `SCULPT_FALLOFFS`

```js
import { SphereGeometry, Mesh, StandardMaterial } from './made3d.module.js';
import {
  Sculptor,
  subdivideGeometry,
  prepareSculptGeometry,
  computeWeldedNormals,
  SCULPT_TOOLS,
  SCULPT_SYMMETRIES,
  SCULPT_FALLOFFS,
} from './src/modules/sculpt.js'; // o `await loadSculpt()`

console.log('Herramientas:', SCULPT_TOOLS);       // ['draw', 'clay', 'grab', 'smooth', 'inflate', 'flatten', 'pinch']
console.log('Simetrías:', SCULPT_SYMMETRIES);     // ['none', 'x', 'y', 'z']
console.log('Perfiles:', SCULPT_FALLOFFS);        // ['smooth', 'sphere', 'tip']

// Subdividir y preparar topología soldada sin grietas en costuras UV
const highGeo = subdivideGeometry(new SphereGeometry(1, 24, 16), 2);
const topo = prepareSculptGeometry(highGeo);
computeWeldedNormals(highGeo, topo);

const clayMesh = new Mesh(highGeo, new StandardMaterial({ color: 0xd97706 }));
Sculptor.ensureUniqueGeometry(clayMesh, scene);

const sculptor = new Sculptor({
  tool: 'clay',
  radius: 0.35,
  strength: 0.5,
  symmetry: 'x',
  falloff: 'smooth',
});
sculptor.attach({
  canvas: sculptOverlay,
  camera,
  controls,
  getTarget: () => clayMesh,
});
sculptor.setEnabled(true);
```

---

## Modelado Poligonal y Subdivisión Suave

### `EditableMesh` y `edgeKey`

Representación poligonal N-gon / quad con tabla topológica cacheada y edición no destructiva o directa.

```js
import { BoxGeometry, Mat4, Vec3, Quat } from './made3d.module.js';
import { EditableMesh, edgeKey } from './src/modules/modeling.js'; // o `await loadModeling()`

const base = EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1));
console.log('Clave arista única:', edgeKey(0, 1)); // '0_1'

// Extruir la cara 0 hacia afuera
const ext = base.extrudeSelection('face', new Set([0]), 0.25);

// Biselado de aristas o caras (bevel)
const bev = base.bevelSelection('edge', new Set([0, 1]), 0.08, 2);

// Puente entre 2 bucles / caras o relleno de hueco (bridge / fill)
const br = base.fillOrBridge('edge', new Set([0, 2]));

// Fusión de vértices cercanos (merge by distance) y soldado coherente de sub-mallas
const merged = base.mergeByDistance(0.005);
base.weldShells({ threshold: 0.02, removeInteriorFaces: true, stitchTJunctions: true });
const unified = EditableMesh.mergeMeshes([
  { editableMesh: base, matrixWorld: new Mat4() },
  {
    editableMesh: EditableMesh.fromGeometry(new BoxGeometry(1, 1, 1)),
    matrixWorld: new Mat4().compose(new Vec3(1, 0, 0), new Quat(), new Vec3(1, 1, 1)),
  },
]);
console.log('Vértices soldados:', unified.mergedVertices, 'Caras interiores eliminadas:', unified.removedInteriorFaces);

// Dureza individual por arista (edge crease) para controlar filos en Catmull-Clark
base.setEdgeCrease(0, 1, 1.0);
base.setSelectionCrease('edge', new Set([0, 1]), 0.85);
console.log('Dureza promedio:', base.getSelectionAverageCrease('edge', new Set([0, 1])));

// Subdivisión localizada, corte por plano local, cuchillo (knifeCut) y bucle (computeLoopCutPlan + loopCut)
base.subdivideSelection('face', new Set([0]), 1);
base.sliceByPlaneLocal({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });

// Reconstruir BufferGeometry respetando suavizado y creaseThreshold
const renderGeo = base.toGeometry({ flatShading: false, creaseThreshold: 0.5 });
```

### `SubdivisionSurface` (Catmull-Clark y modificador no destructivo en `Mesh`)

```js
import {
  MAX_SUBSURF_FACES,
  estimateCatmullClarkFaces,
  getMaxAllowedSubsurfLevel,
  canIncrementSubsurf,
  catmullClarkStep,
  catmullClark,
  getMeshSubsurf,
  isSubsurfSupported,
  ensureEditableBase,
  syncMeshSubsurf,
  setMeshSubsurf,
  applyMeshSubsurf,
  snapshotMeshModelingState,
  restoreMeshModelingState,
  cloneSubsurfState,
} from './src/modules/modeling.js'; // o `await loadModeling()`

if (isSubsurfSupported(mesh)) {
  ensureEditableBase(mesh);
  console.log('Tope de caras:', MAX_SUBSURF_FACES);
  console.log('¿Puede subir nivel?:', canIncrementSubsurf(mesh));

  // Activa Subdivisión Suave nivel 2 sin destruir la jaula base
  setMeshSubsurf(mesh, { level: 2, smoothness: 1.0, smoothShading: true, showCage: true });
  const estado = getMeshSubsurf(mesh);
  console.log('Estimado caras:', estimateCatmullClarkFaces(estado.baseMesh, 2));
  console.log('Nivel máximo permitido:', getMaxAllowedSubsurfLevel(estado.baseMesh));

  // Snapshot / restauración para Undo-Redo y clonado de estado
  const snap = snapshotMeshModelingState(mesh);
  syncMeshSubsurf(mesh);
  restoreMeshModelingState(mesh, snap);

  const otherMesh = mesh.clone();
  cloneSubsurfState(mesh, otherMesh);

  // Hornear permanentemente en la malla base (apply)
  applyMeshSubsurf(mesh);
}

// También utilizable directamente sobre un EditableMesh sin Mesh:
const paso1 = catmullClarkStep(base, 1.0);
const suave = catmullClark(base, 2, MAX_SUBSURF_FACES, 1.0);
```

### `MeshEditor`, `EDIT_SELECTION_MODES`, `EDIT_TRANSFORM_MODES`, `EDIT_CUT_MODES`

Controlador interactivo completo (ratón y táctil con pulsación larga multi-selección amarilla, recuadro de selección, gizmo sobre pivote promedio y corte cuchillo/bucle).

```js
import {
  MeshEditor,
  EDIT_SELECTION_MODES,
  EDIT_TRANSFORM_MODES,
  EDIT_CUT_MODES,
} from './src/modules/modeling.js'; // o `await loadModeling()`

console.log(EDIT_SELECTION_MODES); // ['vertex', 'edge', 'face']
console.log(EDIT_TRANSFORM_MODES); // ['select', 'translate', 'rotate', 'scale']
console.log(EDIT_CUT_MODES);       // ['knife', 'loop']

const meshEditor = new MeshEditor({ selectionMode: 'face', transformMode: 'translate' });
meshEditor.attach({
  canvas: editOverlay,
  camera,
  controls,
  getMesh: () => mesh,
  onChange: () => console.log('Malla modificada'),
});
meshEditor.setMesh(mesh);
meshEditor.setEnabled(true);
meshEditor.setMultiSelectMode(true);
meshEditor.extrudeSelection(0.2);
meshEditor.bevelSelection(0.06, 2);
```

---

## Cargadores y Exportadores

### `GLTFLoader`, `OBJLoader`, `KTX2Loader`, `DRACOLoader`, `ZipLoader`, `extractFilesFromDataTransfer`

`GLTFLoader` importa dinámicamente con `import()` a `ZipLoader`, `KTX2Loader`, `DRACOLoader` y `MeshoptDecoder` **únicamente si el archivo o modelo requiere esa extensión** (`.zip`, `KHR_texture_basisu`, `KHR_draco_mesh_compression` o `EXT_meshopt_compression`).

```js
import { loadGLTFLoader, loadOBJLoader, loadZipLoader } from './made3d.module.js';
// O importación estática: import { GLTFLoader, OBJLoader, KTX2Loader, DRACOLoader, ZipLoader, extractFilesFromDataTransfer } from './src/modules/loaders.js';

const { GLTFLoader } = await loadGLTFLoader();
// Pasar `renderer` permite que GLTFLoader configure KTX2Loader.detectSupport(renderer) automáticamente solo si hace falta:
const gltfLoader = new GLTFLoader({ renderer });
const gltf = await gltfLoader.load('./modelo.glb');
scene.add(gltf.scene);

const { OBJLoader } = await loadOBJLoader();
const objLoader = new OBJLoader();
const objModel = await objLoader.load('./pieza.obj');
scene.add(objModel);

// Descomprimir paquetes ZIP en navegador (o cargar desde File/ArrayBuffer):
const { ZipLoader, extractFilesFromDataTransfer } = await loadZipLoader();
const zipLoader = new ZipLoader();
const virtualFiles = await zipLoader.loadFile(zipFile);

// Drag & Drop de carpetas o múltiples archivos:
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = await extractFilesFromDataTransfer(e.dataTransfer);
  console.log('Archivos arrastrados:', files.length);
});
```

### `GLTFExporter` y `OBJExporter`

```js
import { loadGLTFExporter, loadOBJExporter } from './made3d.module.js';
// O importación estática: import { GLTFExporter, OBJExporter } from './src/modules/exporters.js';

// Exportar escena o selección a GLB binario (ArrayBuffer) o glTF JSON
const { GLTFExporter } = await loadGLTFExporter();
const gltfExporter = new GLTFExporter();
const glbBuffer = await gltfExporter.parseGLB(scene, { onlyVisible: true });
const gltfJson = await gltfExporter.parseGLTF(scene);

// Exportar a Wavefront OBJ (+ MTL opcional)
const { OBJExporter } = await loadOBJExporter();
const objExporter = new OBJExporter();
const objText = objExporter.parse(scene);
const { obj, mtl } = objExporter.parseWithMaterials(scene, { mtlFilename: 'materiales.mtl' });
```

---

## Editor visual (Portátil y Móvil)

El repositorio incluye **Made3D Studio** (`index.html` + `editor/`), una aplicación adaptable a **portátil y móvil**:

- **Barra superior limpia y menús flotantes**:
  - **`Escena`**: `Modelos` (`Importar` todos los formatos compatibles `.glb/.gltf/.obj/.hdr/.ktx2/.zip` y `Exportar` toda la escena o la selección en `.glb`, `.gltf`, `.obj`, `.mtl`) y `Malla` (`Primitivas` con las 16 primitivas + `Arcilla` + `Texto 3D`, y `Agregar` luces direccionales, luces puntuales con visualización de alcance en cruz, cámaras y rigs).
  - **`Objeto`**: Submenús contextuales (`Material`, `Alisar`, `Texto 3D`, `Cámara`, `Luz`, `Pivote`).
  - **Selector de modo (`Pose` | `Modelar` | `Edición`)**:
    - **`Pose`**: Vista limpia con multi-selección amarilla por pulsación prolongada y selección simple al tocar (tocar el vacío deselecciona).
    - **`Modelar`**: Barra vertical izquierda con los 7 pinceles orgánicos y barras verticales derechas de **Radio** y **Fuerza** con valores numéricos + menú `⋯` (`Subdividir ×4`, `Curva caída`, `Simetría`, `Invertir dirección`, `Solo caras frontales`, `Mat. Arcilla`, `+ Esfera`).
    - **`Edición`**: Selector superior izquierdo de **Caras / Aristas / Vértices**, barra vertical izquierda de herramientas (`Extruir` con distancia por doble toque, `Dividir` con `Línea` y `360°`, `Div. ÷4` con número de cortes por doble toque, `Alisar` `1–100` con vista de líneas, `Fusionar` vértices por distancia o soldado coherente de mallas, y menú `⋯` con biselado, puente/relleno y dureza).
  - **`⚙` Ajustes y `☰` Outliner**: Configuración rápida de `HDRI`, `Luces`, `Escenario` y `Visor / Gizmo`, más Outliner desplegable con renombrado en línea, visibilidad ocular, borrado y descarga del repositorio.
- **Dock inferior y panel XYZ por doble toque**:
  - Botones de `Selec.`, `Mover`, `Rotar`, `Escalar`, `Espacio` y `Duplicar` (dos cubos superpuestos) + `Deshacer`/`Rehacer`.
  - Al tocar **2 veces** `Mover`, `Rotar` o `Escalar`, se abre un minipanel horizontal superior con coordenadas `X / Y / Z` editables en tiempo real (en modo Pose transforma el objeto; en Edición mueve los vértices seleccionados y recalcula el pivote promedio).
- **Atajos de teclado**:
  - `Q / W / E / R`: Seleccionar / Mover / Rotar / Escalar
  - `G`: Espacio Global / Local · `P`: Editar Pivote · `B`: Edición poligonal · `S`: Modelar (Esculpido)
  - `V`: Vista de cámara · `Ctrl/Cmd + Z` y `Ctrl/Cmd + Y`: Deshacer / Rehacer
