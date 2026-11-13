// Made3D — librería 3D en JavaScript puro, sin dependencias.
// Uso: import { Scene, PerspectiveCamera, Renderer, ... } from './made3d.module.js';

export const VERSION = '0.5.0';

// math
export * from './src/math/utils.js';
export { Vec2 } from './src/math/Vec2.js';
export { Vec3 } from './src/math/Vec3.js';
export { Quat } from './src/math/Quat.js';
export { Euler } from './src/math/Euler.js';
export { Mat4 } from './src/math/Mat4.js';
export { Color } from './src/math/Color.js';

// core
export { EventEmitter } from './src/core/EventEmitter.js';
export { Clock } from './src/core/Clock.js';
export { Object3D } from './src/core/Object3D.js';
export { Scene } from './src/core/Scene.js';
export { Fog, FogExp2 } from './src/core/Fog.js';
export { Raycaster } from './src/core/Raycaster.js';
export { computeBounds, computeSceneReference, autoScaleObject, resetAutoScale } from './src/core/autoScale.js';

// cámaras
export { Camera, PerspectiveCamera, OrthographicCamera } from './src/cameras/Camera.js';

// geometría
export { BufferAttribute } from './src/geometry/BufferAttribute.js';
export { Geometry } from './src/geometry/Geometry.js';
export { BoxGeometry, PlaneGeometry, SphereGeometry } from './src/geometry/primitives.js';

// materiales y texturas
export { Material, ShaderMaterial } from './src/materials/Material.js';
export { BasicMaterial, StandardMaterial } from './src/materials/BuiltinMaterials.js';
export { Texture } from './src/textures/Texture.js';

// objetos y luces
export { Mesh } from './src/objects/Mesh.js';
export { InstancedMesh } from './src/objects/InstancedMesh.js';
export { ChunkedInstances } from './src/objects/ChunkedInstances.js';
export { GridHelper } from './src/objects/GridHelper.js';
export { Bone } from './src/objects/Bone.js';
export { Skeleton } from './src/objects/Skeleton.js';
export { SkeletonHelper } from './src/objects/SkeletonHelper.js';
export { SkinnedMesh } from './src/objects/SkinnedMesh.js';
export { cloneSkinned } from './src/objects/cloneSkinned.js';
export { Light, AmbientLight, DirectionalLight, PointLight } from './src/lights/Lights.js';

// animación
export { AnimationClip, KeyframeTrack, VectorKeyframeTrack, QuaternionKeyframeTrack } from './src/animation/AnimationClip.js';
export { AnimationMixer, AnimationAction } from './src/animation/AnimationMixer.js';

// cargadores de modelos
export { GLTFLoader } from './src/loaders/GLTFLoader.js';
export { OBJLoader } from './src/loaders/OBJLoader.js';

// picking
export { Picker } from './src/picking/Picker.js';

// render
export { Renderer } from './src/render/Renderer.js';
export { Frustum } from './src/render/Frustum.js';
export { RenderTarget, RenderTargetTexture } from './src/render/RenderTarget.js';

// controles
export { OrbitControls } from './src/controls/OrbitControls.js';

// gizmos (dibujados en canvas 2D)
export { GizmoBase } from './src/gizmo/GizmoBase.js';
export { GizmoMade3d } from './src/gizmo/GizmoMade3d.js';
export { GizmoClassic } from './src/gizmo/GizmoClassic.js';
export { SelectionOutline } from './src/gizmo/SelectionOutline.js';
