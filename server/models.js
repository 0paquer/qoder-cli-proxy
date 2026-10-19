// Model registry aligned with the Qoder model catalog (qodercli 1.1.41).
const MODELS = [
  { id: 'qoder-cn', name: 'Qoder CN Auto', cliModel: 'auto', reasoning: true },
  { id: 'auto', name: 'Auto', cliModel: 'auto', reasoning: true },
  { id: 'ultimate', name: 'Ultimate', cliModel: 'Ultimate', reasoning: true },
  { id: 'performance', name: 'Performance', cliModel: 'Performance', reasoning: true },
  { id: 'efficient', name: 'Efficient', cliModel: 'Efficient', reasoning: true },
  { id: 'lite', name: 'Lite', cliModel: 'Lite', reasoning: true },
  { id: 'cantus', name: 'Cantus', cliModel: 'Cantus', reasoning: true },
  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },
  { id: 'qwen3.8-max-effort-low', name: 'Qwen3.8-Max low', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-medium', name: 'Qwen3.8-Max medium', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-high', name: 'Qwen3.8-Max high', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-max-effort-max', name: 'Qwen3.8-Max max', cliModel: 'Qwen3.8-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', cliModel: 'Qwen3.8-Flash', reasoning: true },
  { id: 'qwen3.7-max', name: 'Qwen3.7-Max', cliModel: 'Qwen3.7-Max', reasoning: true },
  { id: 'qwen3.7-max-effort-low', name: 'Qwen3.7-Max low', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-medium', name: 'Qwen3.7-Max medium', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-high', name: 'Qwen3.7-Max high', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-max-effort-max', name: 'Qwen3.7-Max max', cliModel: 'Qwen3.7-Max', reasoning: true, effortAlias: true },
  { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', cliModel: 'Qwen3.7-Plus', reasoning: true },
  { id: 'kimi-k3', name: 'Kimi-K3', cliModel: 'Kimi-K3', reasoning: true },
  { id: 'kimi-k2.7-code', name: 'Kimi-K2.7-Code', cliModel: 'Kimi-K2.7-Code', reasoning: true },
  { id: 'glm-5.3', name: 'GLM-5.3', cliModel: 'GLM-5.3', reasoning: true },
  { id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', cliModel: 'GLM-5.3-Flash', reasoning: true },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', cliModel: 'DeepSeek-V4-Pro', reasoning: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', cliModel: 'DeepSeek-V4-Flash', reasoning: true },
  { id: 'minimax-m3', name: 'MiniMax-M3', cliModel: 'MiniMax-M3', reasoning: true },
];

const DEFAULT_MODEL_ID = 'qoder-cn';
const EFFORT_SUFFIX_RE = /^(.*)-effort-(low|medium|high|max)$/;

function getModel(modelId) {
  return MODELS.find((model) => model.id === modelId);
}

function resolveCliModel(modelId) {
  if (process.env.QODERCN_MODEL) return process.env.QODERCN_MODEL;
  const model = getModel(modelId) || getModel(canonicalizeModelId(modelId));
  if (model) return model.cliModel;
  // Fallback to auto for unknown models (e.g. claude-haiku, gpt-4, etc.)
  return 'auto';
}

function resolveModelRoute(modelId) {
  const match = modelId ? String(modelId).match(EFFORT_SUFFIX_RE) : null;
  const baseModelId = match ? match[1] : modelId;
  return {
    baseModelId,
    cliModel: resolveCliModel(baseModelId),
    reasoningEffort: match?.[2],
  };
}

/**
 * 把模型目录返回的显示名归一为注册表规范 id（小写），
 * 防止 resolveCliModel 因大小写不匹配静默回退到 auto。
 * 匹配顺序：精确 id → 小写 id → name（忽略大小写）；未知模型保持原样（外部模型兜底逻辑不变）。
 */
function canonicalizeModelId(id) {
  if (typeof id !== 'string' || !id) return id;
  if (getModel(id)) return id;
  const lower = id.trim().toLowerCase();
  const hit = MODELS.find((m) => m.id === lower)
    || MODELS.find((m) => m.name.toLowerCase() === lower);
  return hit ? hit.id : id;
}

/**
 * 归一化模型目录输出条目。
 * SDK 目录返回对象（{id, name...}），静态/兜底来源可能是字符串（"Auto"...）。
 * 返回 {id, name, raw} 或 null（无法识别的条目）。
 */
function normalizeModelEntry(entry) {
  if (typeof entry === 'string') {
    const id = entry.trim();
    return id ? { id: canonicalizeModelId(id), name: id, raw: null } : null;
  }
  if (!entry || typeof entry !== 'object') return null;
  const id = entry.id || entry.modelId || entry.model || entry.name;
  if (!id || typeof id !== 'string') return null;
  return { id: canonicalizeModelId(id), name: entry.name || entry.displayName || id, raw: entry };
}

/**
 * 由模型目录构建倍率索引：key 为小写 displayName / value（模型内部 id）。
 * 兼容两种输入形状：
 *   - SDK daemon 原始 ModelInfo（priceFactor / displayName / value / isFree）
 *   - loadModelCatalog 映射后的条目（rate / name / id / isFree）
 */
function buildRateIndex(catalogModels) {
  const index = new Map();
  for (const m of Array.isArray(catalogModels) ? catalogModels : []) {
    if (!m || typeof m !== 'object') continue;
    const rawRate = Number(m.priceFactor);
    const rate = Number.isFinite(rawRate) ? rawRate : Number(m.rate);
    if (!Number.isFinite(rate)) continue;
    const info = { rate, isFree: Boolean(m.isFree || m.is_free) };
    for (const key of [m.displayName, m.value, m.name, m.id]) {
      if (typeof key === 'string' && key.trim()) {
        const k = key.trim().toLowerCase();
        if (!index.has(k)) index.set(k, info);
      }
    }
  }
  return index;
}

/**
 * 给 {id, name} 模型条目附倍率（rate=null 表示目录中无此模型/无数据）。
 */
function attachRate(entry, rateIndex) {
  const hit = rateIndex && (rateIndex.get(String(entry.name).toLowerCase()) || rateIndex.get(String(entry.id).toLowerCase()));
  return { ...entry, rate: hit ? hit.rate : null, ...(hit && hit.isFree ? { isFree: true } : {}) };
}

module.exports = {
  DEFAULT_MODEL_ID,
  MODELS,
  getModel,
  normalizeModelEntry,
  buildRateIndex,
  attachRate,
  resolveCliModel,
  resolveModelRoute,
};
