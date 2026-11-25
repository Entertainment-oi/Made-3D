import { HistoryManager } from '../core/HistoryManager.js';
import { Sculptor } from '../sculpt/Sculptor.js';

HistoryManager.registerHandlers({ Sculptor });

export {
  Sculptor,
  subdivideGeometry,
  prepareSculptGeometry,
  computeWeldedNormals,
  SCULPT_TOOLS,
  SCULPT_SYMMETRIES,
  SCULPT_FALLOFFS,
} from '../sculpt/Sculptor.js';
