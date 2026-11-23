export { EditableMesh, edgeKey } from '../modeling/EditableMesh.js';
export {
  MAX_SUBSURF_FACES,
  estimateCatmullClarkFaces,
  getMaxAllowedSubsurfLevel,
  canIncrementSubsurf,
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
  pruneNonManifoldFlaps,
  collapseTinySeamSlivers,
  smoothUnionSeam,
} from '../modeling/MeshUnion.js';
