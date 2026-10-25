// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildBackup, inspectBackup, backupBeforeImport, restoreBackup } from './backup.js';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR, DEFAULT_CONFIG } from './config.js';
import { buildChatProfileFrom, resolveChatProfile, skillsViewForProfile } from './chat-profile.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, installByCode } from './market.js';
import { detectDialect as detectThinkingDialect } from './thinking.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  const {
    store, memory, sessions, onebot, orchestrator,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  } = deps;

  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   *
   * @param {string} [chatKey] 指定会话时，判据改用该会话的配置快照
   *   （分会话的工具/技能/视觉开关），并把 chatKey 放进 runtimeContext。
   *   不传则维持全局口径 —— **既有调用方行为不变**。
   *
   * ⚠️ 为什么必须支持 chatKey：依赖 chatKey 的扩展（如 ban-state）在
   *    "UI 用全局档、运行时用会话档"时会显示不一致。带上它之后，
   *    同一会话的设置页与运行时看到的是同一份判据。
   */
  const skillRuntimeContext = (chatKey = null) => {
    const cfg = getConfig();
    const profile = chatKey ? resolveChatProfile(chatKey, cfg) : null;
    return {
      skills: profile ? skillsViewForProfile(skillManager, profile) : skillManager,
      toolsCfg: profile ? profile.tools : (cfg.tools || {}),
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: profile
        ? profile.visionEnabled
        : (cfg.api?.vision !== false && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision'),
      searchEnabled: profile ? profile.searchEnabled : (cfg.webSearch?.enabled !== false),
      // 心智是否启用（设置页/预览的可见性判断）。
      // 注意这是**全局开关**：某次运行是否真正注入还要看 scope（M1 只做私聊）。
      mindEnabled: cfg.mind?.enabled === true,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api',
        ...(chatKey ? { chatKey } : {})
      }
    };
  };

  return [
    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // ┚ SnowLuma 运行判定用 WebUI 端口（进程即起即听）。
        // WS 3001 要等账号登录后才监听，用它判"运行中"会把"起了但未登录"
        // 误报成"未运行"（进而触发二次拉起 → 双实例管道冲突）。
        const webuiPort = deps.snowlumaWebuiPort();
        // 两个端口探测并行：串行时最坏 1.6s（各 800ms 超时），/api/status 每次都卡这么久
        const [slRunning, obPortOpen] = await Promise.all([
          deps.isPortOpen('127.0.0.1', webuiPort),
          deps.isPortOpen('127.0.0.1', snowlumaWsPort())
        ]);
        // 诊断：把"连不上"拆成三种用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!slRunning) onebotDiagnosis = 'SnowLuma 未运行：请到 SnowLuma 页签启动';
          else if (!obPortOpen) onebotDiagnosis = 'SnowLuma 已运行但无账号登录：请在 QQ 里完成登录（登录后数秒内会自动连上）';
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '访问令牌不匹配：正在自动轮换重试，若持续出现请在设置里核对 OneBot 令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '连接中…';
        }
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: slRunning,
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          onebot.close();

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过 qq-agent.lock —— 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── SnowLuma 进程管理 ────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/snowluma/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/snowluma/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: snowlumaLogs.slice(-200) })
    },
    {
      method: 'POST', pattern: '/api/snowluma/stop',
      handler: async ({ res, json }) => {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-folder',
      handler: async ({ res, json }) => {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-webui',
      handler: async ({ res, json }) => {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json }) => json(res, 200, await qqPortableStatus())
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const snow = getConfig().snowluma || {};
        if (which === 'ws') return json(res, 200, { token: String(snow.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(snow.httpAccessToken || snow.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」由内置方言表识别（原 thinking-adapters 插件收编进核心）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            thinking = detectThinkingDialect({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        // chatKey 是**预览目标会话**，不是配置补丁：必须先摘出来，
        // 否则它会被当成配置字段合并进去（config.chatKey 无意义，且会污染预览）。
        const previewChatKey = String(overrides?.chatKey || '').trim() || null;
        const patch = { ...overrides };
        delete patch.chatKey;

        const effective = Object.keys(patch).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(patch))
          : cfg;
        // 指定会话时：用该会话的快照组装，预览才会反映分会话人设/工具/视觉开关。
        // 不指定时维持原有全局口径（行为不变）。
        const profile = previewChatKey ? buildChatProfileFrom(effective, previewChatKey) : null;
        const skillContext = {
          skills: profile ? skillsViewForProfile(skillManager, profile) : skillManager,
          toolsCfg: profile ? profile.tools : (effective.tools || {}),
          visionEnabled: profile
            ? profile.visionEnabled
            : (effective.api?.vision !== false
              && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision'),
          searchEnabled: profile ? profile.searchEnabled : (effective.webSearch?.enabled !== false),
          // 预览要与运行时同口径：心智关闭时，预览里的工具清单也不该出现那四个。
          mindEnabled: effective.mind?.enabled === true,
          runtimeContext: {
            model: effective.api?.model || '',
            provider: effective.api?.provider || '',
            source: 'api',
            ...(previewChatKey ? { chatKey: previewChatKey } : {})
          }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          // 人设文本用会话快照（主人级人设是运行期机制，预览反映不了，属已知差异）
          systemPrompt: buildSystemPrompt({
            skillContext,
            ...(profile ? { persona: profile.persona, profile } : {})
          }),
          tools,
          chatKey: previewChatKey
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──────
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token,
            // 阿里云验证码验签参数：远端市场对发布强制要求（一次性，前端弹出验证后拿到）
            captchaVerifyParam: String(body?.captchaVerifyParam || '')
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会装进 plugins/。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });
        try {
          const r = await installByCode({ code, verified: body?.entry || null });
          // 安装完立即重扫，让新模块马上出现在页签里（热重载 watcher 也行，
          // 但目录删除重建的场景 watcher 会丢事件 —— reload 是唯一可靠路径）
          try { await reloadSkills({ reason: 'market-install' }); } catch { /* 重扫失败不影响安装结果 */ }
          return json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        return json(res, 200, {
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 心智状态：给设置页/GUI 看的只读快照。
      //
      // 为什么单独一个接口而不是塞进 /api/status：status 每几秒被轮询一次，
      // 而关系列表、反思日志这些不该跟着高频刷新。
      //
      // ⚠️ 只读，且**不含任何密钥**：只取 persona.charter 与 mind 的开关类字段。
      method: 'GET', pattern: '/api/mind/state',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        const mind = orchestrator?.mind || null;
        const m = cfg.mind || {};
        const persona = cfg.persona || {};
        const charter = persona.charter || {};

        if (!mind) {
          return json(res, 200, {
            ok: true, available: false,
            enabled: m.enabled === true,
            reason: '心智存储未接入'
          });
        }

        const tick = mind.getTick();
        const self = mind.getSelf();
        const relations = mind.listRelations();
        const events = mind.queryEvents({ limit: 5000 });
        const reflections = mind.listReflections({ limit: 5 });
        const actions = mind.listActions({ limit: 10 });

        // 当前身份来源：roleText 非空 = 旧模式（整段角色卡），否则 charter 模式。
        // 与 prompt.js 判定同口径，UI 才能如实显示"现在到底在用哪套"。
        const mode = String(persona.roleText || '').trim() ? 'roleText' : 'charter';

        // 槽位原样返回（可能含 {botName}，供编辑）+ 一份渲染后的（供预览）。
        // 两者都给，UI 才不会在"编辑模板"和"看实际效果"之间二选一。
        const fill = (s) => String(s ?? '').replaceAll('{botName}', String(persona.botName ?? ''));
        const charterRaw = {
          selfImage: String(charter.selfImage || ''),
          baseline: String(charter.baseline || ''),
          scenario: {
            private: String(charter.scenario?.private || ''),
            group: String(charter.scenario?.group || '')
          },
          voice: Array.isArray(charter.voice) ? charter.voice.map(String) : [],
          hardRules: Array.isArray(charter.hardRules) ? charter.hardRules.map(String) : []
        };

        return json(res, 200, {
          ok: true,
          available: true,
          enabled: m.enabled === true,
          scope: m.scope || 'private',
          mode,
          charter: charterRaw,
          charterResolved: {
            selfImage: fill(charterRaw.selfImage),
            baseline: fill(charterRaw.baseline),
            scenario: { private: fill(charterRaw.scenario.private), group: fill(charterRaw.scenario.group) },
            voice: charterRaw.voice.map(fill),
            hardRules: charterRaw.hardRules.map(fill)
          },
          roleTextChars: String(persona.roleText || '').length,
          // 她的名字（botName）：编辑身份时可以直接改，不必走出生仪式
          botName: String(persona.botName || ''),
          // 节律参数（「她 → 节律」页用）：当前值 + 默认值（供"恢复默认"）
          energy: m.energy || {},
          tickConfig: m.tick || {},
          reflectConfig: {
            reflectAfterEvents: m.reflectAfterEvents,
            reflectCooldownMs: m.reflectCooldownMs,
            reflectMaxEvents: m.reflectMaxEvents,
            reflectMaxRelations: m.reflectMaxRelations
          },
          defaults: {
            energy: DEFAULT_CONFIG.mind.energy,
            tick: DEFAULT_CONFIG.mind.tick,
            sleep: DEFAULT_CONFIG.mind.sleep,
            reflect: {
              reflectAfterEvents: DEFAULT_CONFIG.mind.reflectAfterEvents,
              reflectCooldownMs: DEFAULT_CONFIG.mind.reflectCooldownMs,
              reflectMaxEvents: DEFAULT_CONFIG.mind.reflectMaxEvents,
              reflectMaxRelations: DEFAULT_CONFIG.mind.reflectMaxRelations
            }
          },
          self: {
            version: Number(self.version) || 0,
            narrative: String(self.narrative || ''),
            mood: { label: String(self.mood?.label || ''), valence: Number(self.mood?.valence) || 0 },
            preoccupations: Array.isArray(self.preoccupations) ? self.preoccupations : [],
            updatedAt: Number(self.updatedAt) || 0
          },
          relations: relations.map((r) => ({
            userId: String(r.userId || ''),
            names: Array.isArray(r.names) ? r.names : [],
            nickname: String(r.nickname || ''),
            stage: String(r.stage || 'stranger'),
            trust: Number(r.trust) || 0,
            warmth: Number(r.warmth) || 0,
            knownFor: Array.isArray(r.knownFor) ? r.knownFor : [],
            tender: Array.isArray(r.tender) ? r.tender : [],
            openLoops: Array.isArray(r.openLoops) ? r.openLoops.map((l) => l?.text ?? String(l)) : [],
            recentSummary: String(r.recentSummary || ''),
            confidence: Number(r.confidence) || 0,
            updatedAt: Number(r.updatedAt) || 0
          })),
          tick: {
            energy: Number(tick.energy) || 0,
            today: String(tick.today || ''),
            todayProactive: Number(tick.todayProactive) || 0,
            todayDecisions: Number(tick.todayDecisions) || 0,
            todayReflections: Number(tick.todayReflections) || 0,
            lastReflectAt: Number(tick.lastReflectAt) || 0,
            lastReflectAttemptAt: Number(tick.lastReflectAttemptAt) || 0,
            sleep: {
              state: String(tick.sleep?.state || 'awake'),
              stayUps: Number(tick.sleep?.stayUps) || 0,
              nightKey: String(tick.sleep?.nightKey || '')
            }
          },
          sleep: {
            enabled: cfg.mind?.sleep?.enabled === true,
            asleep: orchestrator?.asleep === true,
            // 为什么现在是这个状态：UI 要能解释"改了入睡时间却还醒着"
            reason: String(orchestrator?.sleepReason || ''),
            nextEligibleAt: Number(orchestrator?.sleepNextEligibleAt) || 0,
            window: orchestrator?.sleepWindow
              ? {
                  nightKey: orchestrator.sleepWindow.nightKey,
                  startAt: orchestrator.sleepWindow.startAt,
                  endAt: orchestrator.sleepWindow.endAt
                }
              : null,
            // 配置本身也回传：UI 要能就地改作息，而不是让用户去翻 config.json
            config: {
              startHour: Number(cfg.mind?.sleep?.startHour ?? 23),
              startMinute: Number(cfg.mind?.sleep?.startMinute ?? 30),
              endHour: Number(cfg.mind?.sleep?.endHour ?? 8),
              endMinute: Number(cfg.mind?.sleep?.endMinute ?? 0),
              jitterMin: Number(cfg.mind?.sleep?.jitterMin ?? 40),
              maxStayUp: Number(cfg.mind?.sleep?.maxStayUp ?? 2),
              graceMs: Number(cfg.mind?.sleep?.graceMs ?? 900000)
            }
          },
          counts: {
            events: events.length,
            uncompacted: events.filter((e) => !(Array.isArray(e.summaryOf) && e.summaryOf.length)).length,
            relations: relations.length,
            reflections: reflections.length
          },
          // 反思的"为什么还没跑"：阈值、攒了几条、冷却还剩多久。
          // 这些不显示出来，用户只能干等（真实反馈）。
          reflect: (() => {
            const privateChats = (store.listChats?.() || []).filter((k) => String(k).startsWith('private:'));
            const since = Number(tick.lastReflectAt) || 0;
            const unreflected = privateChats.reduce((n, k) => n + (mind.countUnreflected(k, since) || 0), 0);
            const need = Math.max(1, Number(m.reflectAfterEvents) || 8);
            const cooldown = Math.max(60000, Number(m.reflectCooldownMs) || 7200000);
            const lastAttempt = Number(tick.lastReflectAttemptAt) || 0;
            const cooldownUntil = lastAttempt > 0 ? lastAttempt + cooldown : 0;
            const dailyCap = Math.max(1, Number(m.tick?.maxReflectPerDay) || 8);
            const usedToday = tick.today === todayKey() ? (Number(tick.todayReflections) || 0) : 0;
            return {
              unreflected, need, cooldownUntil, usedToday, dailyCap,
              canReflect: unreflected >= need && (cooldownUntil === 0 || Date.now() >= cooldownUntil) && usedToday < dailyCap,
              chatKey: privateChats[0] || ''
            };
          })(),
          recentReflections: reflections,
          recentActions: actions
        });
      }
    },
    {
      // 记忆流：她经历过的事（事件时间线）。
      // 与「最近反思」的区别：反思是压缩后的结论，这里是一手经历。
      method: 'GET', pattern: '/api/mind/events',
      handler: async ({ res, json, url }) => {
        const mind = orchestrator?.mind || null;
        if (!mind) return json(res, 200, { ok: true, events: [] });
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 60));
        const chatKey = String(url.searchParams.get('chatKey') || '').trim();
        const actorId = String(url.searchParams.get('actor') || '').trim();
        const includeCompacted = url.searchParams.get('compacted') === '1';
        const events = mind.queryEvents({
          ...(chatKey ? { chatKey } : {}),
          ...(actorId ? { actorId } : {}),
          limit,
          includeCompacted
        });
        // 时间线从新到旧更好读（存储层按升序返回）
        const list = events.slice().reverse().map((e) => ({
          id: e.id, ts: e.ts,
          chatKey: e.chatKey || '',
          actorId: e.actorId || '',
          actorName: e.actorName || '',
          kind: e.kind || '',
          text: String(e.text || ''),
          salience: Number(e.salience) || 0,
          valence: Number(e.valence) || 0,
          tags: Array.isArray(e.tags) ? e.tags : [],
          compacted: e.compacted === true,
          summaryOf: Array.isArray(e.summaryOf) ? e.summaryOf : []
        }));
        return json(res, 200, { ok: true, events: list });
      }
    },
    {
      // 会话级配置：每个群/私聊独享一套覆盖（M0 做好的 chatProfiles，此前没有界面）
      method: 'GET', pattern: '/api/chat-profiles',
      handler: async ({ res, json }) => {
        const cfg = getConfig();
        return json(res, 200, {
          ok: true,
          profiles: cfg.chatProfiles || {},
          chatKeys: (store.listChats?.() || [])
        });
      }
    },
    {
      method: 'POST', pattern: '/api/chat-profiles',
      handler: async ({ req, res, json }) => {
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }
        const chatKey = String(body.chatKey || '').trim();
        if (!chatKey) return json(res, 400, { ok: false, error: '缺少 chatKey' });

        const current = { ...(getConfig().chatProfiles || {}) };
        if (body.clear === true) {
          delete current[chatKey];
        } else {
          const patch = (body.patch && typeof body.patch === 'object') ? body.patch : {};
          current[chatKey] = { ...(current[chatKey] || {}), ...patch };
        }
        // __replace__：映射型字段要"删掉旧键"，普通深合并做不到（见 config.deepMerge）
        updateConfig({ chatProfiles: { __replace__: current } });
        return json(res, 200, { ok: true, profiles: getConfig().chatProfiles || {} });
      }
    },
    {
      // 主人手动编辑"她对自己的描述"。
      // 与工具 self_revise 的区别：来源记为 owner（changelog 可追溯），
      // 而且**不做人格底线校验之外的新限制** —— 主人本来就该有最终决定权。
      // 界面上有伦理提示：这是改写她已经经历过的自我，不建议当基因编辑用。
      method: 'POST', pattern: '/api/mind/self/edit',
      handler: async ({ req, res, json }) => {
        const mind = orchestrator?.mind || null;
        if (!mind) return json(res, 200, { ok: false, error: '心智未接入' });
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }

        const patch = {};
        if (typeof body.narrative === 'string') patch.narrative = body.narrative.slice(0, 1200);
        if (body.moodLabel !== undefined || body.moodValence !== undefined) {
          patch.mood = { label: String(body.moodLabel ?? '').slice(0, 20), valence: body.moodValence };
        }
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有要修改的内容' });

        const r = mind.reviseSelf(patch, {
          by: 'owner',
          reason: String(body.reason || '主人在界面里手动修改').slice(0, 120)
        });
        if (!r.ok) return json(res, 200, { ok: false, error: r.reason || '修改被拒绝' });
        return json(res, 200, { ok: true, version: r.self.version, narrative: r.self.narrative });
      }
    },
    {
      // 主人手动编辑某段关系（信任/亲近/阶段/称呼/雷点）。
      // evidence 记 'owner:manual'，之后看关系档案时能分辨"这是她自己处出来的"还是"主人改的"。
      method: 'POST', pattern: '/api/mind/relation/edit',
      handler: async ({ req, res, json }) => {
        const mind = orchestrator?.mind || null;
        if (!mind) return json(res, 200, { ok: false, error: '心智未接入' });
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }

        const userId = String(body.userId || '').trim();
        if (!/^\d{1,15}$/.test(userId)) return json(res, 400, { ok: false, error: 'userId 必须是数字 QQ 号' });

        const ALLOW = ['nickname', 'stage', 'trust', 'warmth', 'knownFor', 'tender', 'recentSummary'];
        const patch = {};
        for (const k of ALLOW) if (body.patch && body.patch[k] !== undefined) patch[k] = body.patch[k];
        if (!Object.keys(patch).length) return json(res, 400, { ok: false, error: '没有要修改的内容' });

        const r = mind.patchRelation(userId, patch, { evidence: ['owner:manual'], now: Date.now() });
        if (!r.ok) return json(res, 200, { ok: false, error: r.reason || '修改失败' });
        return json(res, 200, {
          ok: true,
          relation: {
            userId, stage: r.relation.stage, trust: r.relation.trust,
            warmth: r.relation.warmth, nickname: r.relation.nickname
          },
          clamp: r.clamp || []
        });
      }
    },
    {
      // 导出备份：her = 只有她自己；full = 再加聊天记录等（仍不含 config.json）
      method: 'GET', pattern: '/api/backup/export',
      handler: async ({ res, url }) => {
        const kind = url.searchParams.get('kind') === 'full' ? 'full' : 'her';
        const { buffer, files } = buildBackup({
          dataDir: DATA_DIR,
          config: getConfig(),
          kind,
          appVersion: typeof localVersion === 'string' ? localVersion : ''
        });
        const stamp = new Date().toISOString().slice(0, 10);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="qq-agent-${kind}-${stamp}.zip"`,
          'content-length': buffer.length
        });
        res.end(buffer);
        return { ok: true, kind, files, bytes: buffer.length };
      }
    },
    {
      // 导入备份：先给当前数据打包（后悔药），再还原。
      // 包里没有 config.json，所以导入**不会**覆盖本机设置与 API Key。
      method: 'POST', pattern: '/api/backup/import',
      handler: async ({ req, res, json }) => {
        const len = Number(req.headers['content-length'] || 0);
        if (len > 600 * 1024 * 1024) return json(res, 413, { ok: false, error: '备份文件过大' });
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return json(res, 400, { ok: false, error: '没有收到文件' });

        let parsed;
        try { parsed = inspectBackup(buffer); } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }

        let pre = null;
        try {
          pre = backupBeforeImport({ dataDir: DATA_DIR, config: getConfig(), appVersion: typeof localVersion === 'string' ? localVersion : '' });
        } catch (error) {
          // 做不出后悔药就不许导入 —— 宁可失败也不能冒不可回滚的风险
          return json(res, 500, { ok: false, error: `导入前备份失败，已中止：${error?.message ?? error}` });
        }

        const result = restoreBackup({ dataDir: DATA_DIR, entries: parsed.entries, manifest: parsed.manifest });

        // persona 属于"她"，从包里恢复；其余设置一概不碰
        if (parsed.persona && typeof parsed.persona === 'object') {
          const p = parsed.persona;
          const personaPatch = {};
          for (const k of ['botName', 'selfNickname', 'roleText', 'participation', 'charter']) {
            if (p[k] !== undefined) personaPatch[k] = p[k];
          }
          const patch = { persona: personaPatch };
          if (p.memberNotes && typeof p.memberNotes === 'object') patch.memberNotes = p.memberNotes;
          try { updateConfig(patch); } catch { /* 单字段失败不影响数据还原 */ }
        }

        // 让 UI 立刻看到新状态
        try { orchestrator.stopTickLoop(); } catch { /* ignore */ }
        try { orchestrator.startTickLoop(); } catch { /* ignore */ }

        return json(res, 200, {
          ok: true,
          kind: result.kind,
          restored: result.restored,
          dirs: result.dirs,
          preBackup: pre?.name || ''
        });
      }
    },
    {
      // 心跳日志：最近心跳（内存，含跳过）+ 已落盘的行动/反思 + 文件体积。
      // 分开给两份数据是刻意的：跳过的心跳每 60 秒一次，写盘会无限膨胀；
      // 但用户排查时又需要看到"她刚才为什么没动"，所以放内存里滚动保留。
      method: 'GET', pattern: '/api/mind/tick-log',
      handler: async ({ res, json, url }) => {
        const mind = orchestrator?.mind || null;
        if (!mind) return json(res, 200, { ok: true, recentTicks: [], actions: [], reflections: [], sizes: { actions: 0, reflections: 0, total: 0 } });
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        return json(res, 200, {
          ok: true,
          recentTicks: Array.isArray(orchestrator.recentTicks) ? orchestrator.recentTicks : [],
          actions: mind.listActions({ limit }),
          reflections: mind.listReflections({ limit: Math.min(50, limit) }),
          sizes: mind.logSizes()
        });
      }
    },
    {
      // 清空日志（磁盘自己管）。只清 actions/reflections 两个日志文件，
      // 事件、关系、自我一个字都不碰 —— 那些是她的记忆，不是日志。
      method: 'POST', pattern: '/api/mind/logs/clear',
      handler: async ({ req, res, json }) => {
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }
        const mind = orchestrator?.mind || null;
        if (!mind) return json(res, 200, { ok: false, error: '心智未接入' });
        const scope = String(body.scope || 'all');
        const r = mind.clearLogs({
          actions: scope === 'all' || scope === 'actions',
          reflections: scope === 'all' || scope === 'reflections'
        });
        if (Array.isArray(orchestrator.recentTicks)) orchestrator.recentTicks = [];
        return json(res, 200, { ok: true, ...r, sizes: mind.logSizes() });
      }
    },
    {
      // 手动触发一次反思（调试/测试用）。
      // 没有它的话，反思只会在"攒够 8 条 + 过冷却"时静默发生，
      // 用户既不知道何时发生，也没法验证它是否工作。
      method: 'POST', pattern: '/api/mind/reflect',
      handler: async ({ req, res, json }) => {
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }
        const mind = orchestrator?.mind || null;
        if (!mind) return json(res, 200, { ok: false, error: '心智未接入' });
        // 指定会话优先；否则挑一个私聊（M1 只对私聊反思）
        const explicit = String(body.chatKey || '').trim();
        const chatKey = explicit || (store.listChats?.() || []).find((k) => String(k).startsWith('private:')) || '';
        if (!chatKey) return json(res, 400, { ok: false, error: '没有可反思的私聊会话' });
        try {
          const r = await orchestrator.reflectForChat(chatKey);
          return json(res, 200, { ...r, chatKey });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 出生仪式：只出草案，**不写盘**。
      // 写盘走 POST /api/config —— 必须由主人点"采用这组"之后才发生。
      // 理由：身份是一次性的，不该被一次模型调用直接定下来。
      method: 'POST', pattern: '/api/mind/charter/draft',
      handler: async ({ req, res, json }) => {
        let body = {};
        try { body = await readBody(req); } catch { body = {}; }
        const seed = (body?.seed && typeof body.seed === 'object') ? body.seed : body;
        const keywords = Array.isArray(seed.keywords) ? seed.keywords : String(seed.keywords ?? '');
        const vision = String(seed.vision ?? '');
        const hasSeed = (Array.isArray(keywords) ? keywords.length > 0 : Boolean(String(keywords).trim()))
          || Boolean(vision.trim());
        if (!hasSeed) {
          return json(res, 400, { ok: false, error: '至少给一点形象关键词或一句愿景' });
        }
        try {
          const r = await orchestrator.draftCharter({ keywords, vision });
          if (!r.ok) {
            return json(res, 502, { ok: false, error: r.reason || '生成失败', rejected: r.rejected || [] });
          }
          return json(res, 200, { ok: true, drafts: r.drafts, rejected: r.rejected || [] });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          // ⚠️ 与 settingsView 同一套口径（2026-09-26 审查二轮）：
          //    ① secret 标记；② 字段名命中 /key|token|secret|password|cookie/i 的
          //    字符串字段（web-fetch 的 cookie 没有 secret 标记也属密文）。
          //    收到掩码 '******' 或空串 = "不修改" —— 否则用户只是打开表单点了
          //    保存，Cookie/Key 就被覆盖成六个星号。
          const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
          const isSecretField = (k) => Boolean(schema[k]?.secret)
            || (SECRET_NAME_RE.test(k) && typeof current[k] === 'string');
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            if (isSecretField(k) && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        // 心智节律：运行期开关也要生效（否则改完必须重启才跑心跳）。
        // 与 app 启动时同一条互斥规则：心智节律开启时，旧的概率式 proactive 让位。
        const mindTickOn = next.mind?.enabled === true && next.mind?.tick?.enabled !== false;
        if (mindTickOn) { orchestrator.startTickLoop(); orchestrator.stopProactiveLoop(); }
        else orchestrator.stopTickLoop();
        // 运行期切开心智时也补一次迁移（不依赖心跳开关）。
        if (next.mind?.enabled === true) {
          try { orchestrator.migrateImpressionsToRelations(); } catch { /* 迁移失败不影响配置保存 */ }
        }
        // 作息配置改完后立刻重算一次：否则胶囊要等下一次心跳才更新（最多 60 秒），
        // 用户会以为"改了没生效"。
        try { orchestrator.syncSleep?.(); } catch { /* 刷新失败不影响保存 */ }
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch,
          // 来源标记：属于哪个 Skill（内置工具为 null）—— UI 据此打「skill」标识，
          // 并在所属技能失活时把工具整组隐藏（与提示词口径一致）。
          skillId: t.skillId ?? null
        }));
        return json(res, 200, { tools });
      }
    },

    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, { version: localVersion() })
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        const current = localVersion();
        try {
          const r = await fetch(UPDATE_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            url: String(info.url || 'https://kondius.cn/qq-agent'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 记忆 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        const seen = new Set(files.map((f) => f.chatKey));
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: match[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeMember(chatKey, match[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        memory.removeChat(chatKey);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-files/consolidate',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          const force = body.force !== false;
          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) }))
            .catch((error) => emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) }))
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_(\d+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/wake$/,
      handler: async ({ res, json }) => json(res, 410, { error: '已移除：不触发的消息现在会立即标为已读，无需手动唤醒' })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        // ⚠️ 白名单闸（2026-09-26 审查二轮）：本端点曾接受任意 group/private id ——
        //   任何通过来源校验的本地进程都能借它向**白名单外**的群/私聊发消息
        //   （绕过 send_to 工具的硬校验，等于给管理端开了一条无白名单的发送通道）。
        //   现在与 app.allowed() 同口径：deny 优先；allow 非空时必须在名单内；
        //   全空时必须显式开 allowAllWhenEmpty。
        const kind = match[1];
        const id = match[2];
        const cfgNow = getConfig();
        const denyList = cfgNow.deny?.[kind] ?? cfgNow.deny?.[`${kind}s`] ?? [];
        if (denyList.map(String).includes(String(id))) {
          return json(res, 403, { error: '该会话在黑名单内，不能发送' });
        }
        const allowList = cfgNow.allow?.[kind] ?? cfgNow.allow?.[`${kind}s`] ?? [];
        const allowed = allowList.length > 0
          ? allowList.map(String).includes(String(id))
          : cfgNow.allowAllWhenEmpty === true;
        if (!allowed) {
          return json(res, 403, { error: '该会话不在白名单内，不能发送（先在设置里加白名单，或开启空白名单放行）' });
        }
        try {
          const chatKey = `${kind}:${id}`;
          const data = await onebot.sendText(kind, id, text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/,
      handler: async ({ res, json, match }) => json(res, 200, { ok: true, marked: store.drainUnread(`${match[1]}:${match[2]}`).length })
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/clear$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ── 验证码请求转发（2026-09-26）────────────────────────────────
    // 部分用户机器上 Chromium 渲染层对 *.aliyuncs.com / *.alicdn.com 的请求被
    // 本机安全软件按进程+域名压制（同机 Node 层、系统 curl 均正常），SDK 走不通。
    // 由主进程 Node 层（undici，网络栈独立且实测可达）代为转发。
    // 安全边界（防 SSRF）：目标仅允许 https + aliyuncs/alicdn 两族域名后缀；
    // 不跟随重定向；body 上限 8MB；响应上限 16MB；超时 15s。
    {
      method: '*', pattern: /^\/api\/captcha-forward\/?$/,
      handler: async ({ req, res, json, url }) => {
        const target = String((url && url.searchParams.get('u')) || '');
        let parsed;
        try { parsed = new URL(target); } catch {
          return json(res, 400, { ok: false, error: '缺少或非法的 u 参数' });
        }
        if (parsed.protocol !== 'https:' ||
            !/^[a-zA-Z0-9.-]+\.(aliyuncs\.com|alicdn\.com)$/.test(parsed.hostname)) {
          return json(res, 403, { ok: false, error: `目标不在转发白名单（仅 https 的 aliyuncs/alicdn 域）：${parsed.hostname}` });
        }
        // 读原始 body（POST 等需要；上限 8MB）
        const chunks = [];
        let size = 0;
        try {
          await new Promise((resolve, reject) => {
            req.on('data', (c) => {
              size += c.length;
              if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
              chunks.push(c);
            });
            req.on('end', resolve);
            req.on('error', reject);
          });
        } catch { /* 读失败按空 body 处理 */ }
        const reqBody = Buffer.concat(chunks);

        // 复制请求头（剥掉 hop-by-hop 与本机信息头）
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const kl = k.toLowerCase();
          if (['host', 'cookie', 'connection', 'content-length', 'origin', 'referer',
               'accept-encoding', 'transfer-encoding', 'upgrade', 'expect'].includes(kl)) continue;
          fwdHeaders[k] = v;
        }
        if (reqBody.length && !fwdHeaders['content-type']) fwdHeaders['content-type'] = 'application/octet-stream';

        try {
          const up = await fetch(parsed.href, {
            method: req.method,
            headers: fwdHeaders,
            body: (req.method === 'GET' || req.method === 'HEAD' || reqBody.length === 0) ? undefined : reqBody,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
          });
          const buf = Buffer.from(await up.arrayBuffer());
          if (buf.length > 16 * 1024 * 1024) {
            return json(res, 502, { ok: false, error: '转发响应过大（>16MB）' });
          }
          const resHeaders = {};
          up.headers.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (['transfer-encoding', 'content-encoding', 'content-length', 'connection', 'keep-alive'].includes(kl)) return;
            resHeaders[k] = v;
          });
          resHeaders['access-control-allow-origin'] = '*';   // 同源请求用不到，留作兜底
          res.writeHead(up.status, resHeaders);
          res.end(buf);
        } catch (e) {
          return json(res, 502, { ok: false, error: `转发失败：${String(e?.cause?.code || e?.message || e).slice(0, 120)}` });
        }
        return undefined;   // 已自行写响应
      }
    },
  ];
}
