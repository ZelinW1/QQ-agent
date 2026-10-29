// 心智子系统对外入口。
//
// 已实现：存储 + 检索（PR1）、注入与采集（PR2）、工具（PR3）、反思（PR4）。
// 节律（tick.js）在后续 PR 加入，届时从这里一并导出。
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

export {
  buildReflectPrompt,
  parseReflectOutput,
  applyReflection
} from './reflect.js';

export {
  settleEnergy,
  resetDaily,
  collectCandidates,
  buildGlobalDecisionPrompt,
  scoreRosterEntry,
  truncateText,
  nextTickAt,
  actionBlocked
} from './tick.js';

export { ACTIONS, getAction, availableActions, blockedActions, actionsWithCosts } from './actions.js';

export { extensionActions } from './extensions.js';

export { resolveSleepWindow, classifySleep, describeWindow } from './sleep.js';

export { buildBirthPrompt, parseBirthDrafts, validateDraft } from './birth.js';
