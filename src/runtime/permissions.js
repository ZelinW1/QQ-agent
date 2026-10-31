// 权限：能力范围（scope）与策略。
//
// 设计 §5.4 的 A 期只做三样：scope、policy、identity。
// 本文件负责前两样，identity 由管线在 validate 阶段用"注册表里的定义"完成。
//
// 关键取舍：
//   · 内置工具可信（作者即用户），没有声明的 scope 一律放行；
//   · 扩展工具默认 **ask**：新装的东西可以"想"调，但必须主人点头；
//   · 策略表在配置里，deny 永远优先；ask 在没有批准通道时按拒绝处理（fail closed），
//     拒绝原因会进 attempts / 界面，不静默。

/** 已知能力范围。不在表里的字符串仍可声明，只是策略回落到默认值。 */
export const SCOPES = Object.freeze([
  'chat.send',   // 以她的身份往外发消息
  'net.fetch',   // 访问外网
  'mind.write',  // 改她的记忆/自我/关系
  'fs.read',     // 读本机文件
  'sys.exec'     // 执行命令
]);

/** 默认策略：内置信任、执行命令默认拒绝、其余扩展默认询问。 */
export const DEFAULT_SCOPE_POLICY = Object.freeze({
  'chat.send': 'allow',
  'net.fetch': 'allow',
  'mind.write': 'allow',
  'fs.read': 'allow',
  'sys.exec': 'deny'
});

/**
 * 算出某个工具每个 scope 的实际策略。
 *
 * @param {object} tool 工具定义（带 traits.scopes 与 skillId）
 * @param {object} cfg 配置
 * @returns {{scope:string, policy:'allow'|'ask'|'deny'}[]}
 */
export function scopePolicyFor(tool, cfg = {}) {
  const scopes = Array.isArray(tool?.traits?.scopes) ? tool.traits.scopes.map(String) : [];
  if (!scopes.length) return [];
  const table = { ...DEFAULT_SCOPE_POLICY, ...(cfg.tools?.scopePolicy || {}) };
  const isExtension = Boolean(tool?.skillId);
  return scopes.map((scope) => ({
    scope,
    // 内置工具没写进策略表 → 信任；扩展工具没写 → 询问（首装默认 ask）。
    policy: table[scope] || (isExtension ? 'ask' : 'allow')
  }));
}

/**
 * 检查一个工具能不能调。
 *
 * @param {object} tool
 * @param {object} cfg
 * @param {{approved?:string[]}} [opts] approved = 本次已获批准的 scope（UI 流程接进来前通常为空）
 * @returns {{ok:boolean, code?:string, message?:string, scopes:object[]}}
 */
export function checkScopes(tool, cfg = {}, { approved = [] } = {}) {
  const entries = scopePolicyFor(tool, cfg);
  if (!entries.length) return { ok: true, scopes: [] };

  const approvedSet = new Set(Array.isArray(approved) ? approved : []);
  const denied = entries.filter((e) => e.policy === 'deny');
  if (denied.length) {
    return {
      ok: false,
      code: 'scope-denied',
      message: `没有权限：${denied.map((e) => e.scope).join('、')}`,
      scopes: entries
    };
  }
  const ask = entries.filter((e) => e.policy === 'ask' && !approvedSet.has(e.scope));
  if (ask.length) {
    return {
      ok: false,
      code: 'scope-ask',
      message: `需要主人批准：${ask.map((e) => e.scope).join('、')}`,
      scopes: entries
    };
  }
  return { ok: true, scopes: entries };
}
