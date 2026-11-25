import { bindRenderPreviewModal } from './cameraView.js';
import {
  closeAllPopovers,
  openPopover,
  switchTab,
  syncAppModeUI,
  syncViewCameraQuickBtn,
  bindPopoverNav,
} from './ui/popovers.js';
import { renderObjectList, bindOutlinerActions } from './ui/outliner.js';
import {
  syncGizmoXyzPanel,
  syncTransformInputs,
  bindGizmoControls,
} from './ui/gizmoPanel.js';
import {
  switchObjectSubtab,
  syncSelectedUI,
  bindObjectInspector,
} from './ui/objectInspector.js';
import { bindSettingsPanel } from './ui/settingsPanel.js';
import { bindShortcutsAndModes } from './ui/shortcuts.js';
import { bindRangeControls } from './ui/rangeControls.js';

export {
  closeAllPopovers,
  openPopover,
  switchTab,
  syncAppModeUI,
  syncViewCameraQuickBtn,
  renderObjectList,
  syncGizmoXyzPanel,
  syncTransformInputs,
  switchObjectSubtab,
  syncSelectedUI,
};

export function bindUI() {
  bindPopoverNav();
  bindOutlinerActions();
  bindGizmoControls();
  bindObjectInspector();
  bindSettingsPanel();
  bindShortcutsAndModes();
  bindRangeControls();
  bindRenderPreviewModal();
}
