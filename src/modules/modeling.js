import { HistoryManager } from '../core/HistoryManager.js';
import {
  restoreMeshModelingState,
  syncEditableBaseFromGeometry,
} from '../modeling/SubdivisionSurface.js';

HistoryManager.registerHandlers({
  restoreMeshModelingState,
  syncEditableBaseFromGeometry,
});

export { EditableMesh, edgeKey } from '../modeling/EditableMesh.js';
export {
  MAX_SUBSURF_FACES,
  MIN_DENSITY_VERTS,
  MAX_DENSITY_FACES,
  MAX_DENSITY_VERTS,
  estimateCatmullClarkFaces,
  getMaxAllowedSubsurfLevel,
  canIncrementSubsurf,
  canIncreaseMeshDensity,
  canDecreaseMeshDensity,
  adjustMeshVertexDensity,
  catmullClarkStep,
  catmullClark,
  getMeshSubsurf,
  isSubsurfSupported,
  ensureEditableBase,
  syncEditableBaseFromGeometry,
  syncMeshSubsurf,
  setMeshSubsurf,
  applyMeshSubsurf,
  snapshotMeshModelingState,
  restoreMeshModelingState,
  cloneSubsurfState,
  getMeshDensityInfo,
  hasModelingStateChanged,
  mergeObjectMeshes,
  weldObjectMesh,
} from '../modeling/SubdivisionSurface.js';
export {
  MeshEditor,
  EDIT_SELECTION_MODES,
  EDIT_TRANSFORM_MODES,
  EDIT_CUT_MODES,
} from '../modeling/MeshEditor.js';
export {
  computeFaceShellIds,
  performVolumetricUnionIfNeeded,
  performOrganicSdfUnion,
  decimateMeshQEM,
  pruneNonManifoldFlaps,
  collapseTinySeamSlivers,
  smoothUnionSeam,
} from '../modeling/MeshUnion.js';
