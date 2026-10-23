// 心智子系统对外入口。
//
// 已实现：存储 + 检索（PR1）、注入与采集（PR2）。
// 反思（reflect.js）与节律（tick.js）在后续 PR 加入，届时从这里一并导出，
// 调用方（orchestrator / tools）只认这个入口。
//
// ⚠️ 本目录不得 import orchestrator.js（防循环依赖）。
export {
  MindStore,
  EVENT_KINDS,
  STAGES,
  STAGE_LEVEL,
  MIND_DIR,
  MIND_LIMITS,
  mindChatDirName
} from './store.js';

export {
  tokenize,
  scoreEvent,
  selectRecall,
  formatRecallForPrompt
} from './recall.js';

export {
  renderSelfSection,
  renderRelationsSection,
  renderRecentSection,
  mindFingerprint,
  collectMindContext
} from './inject.js';
