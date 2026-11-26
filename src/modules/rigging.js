import { HistoryManager } from '../core/HistoryManager.js';
import { Skeleton } from '../objects/Skeleton.js';

HistoryManager.registerHandlers({ Skeleton });

export { Bone } from '../objects/Bone.js';
export { Skeleton } from '../objects/Skeleton.js';
export { SkeletonHelper, collectRigFromTarget } from '../objects/SkeletonHelper.js';
export { SkinnedMesh } from '../objects/SkinnedMesh.js';
export { cloneSkinned, cloneObject } from '../objects/cloneSkinned.js';
export {
  Rigger,
  computeAutoSkinWeights,
  weightToHeatRgb,
  updateMeshWeightHeatmap,
  applyWeightBrushAt,
  bindMeshesToSkeleton,
} from '../objects/Rigger.js';
