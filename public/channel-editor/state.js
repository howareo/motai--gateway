import { parseModelList } from '../shared/model-list.js';

function editorId() {
  if (globalThis.crypto.randomUUID) return globalThis.crypto.randomUUID();
  // LAN HTTP lacks randomUUID in some browsers; getRandomValues remains available there.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createEditorDraft(channel = null, { operationId = editorId(), sessionId = editorId() } = {}) {
  return {
    sessionId, operationId, channelId: channel?.id ?? null, closed: false,
    name: channel?.name || '', poolId: channel?.poolId || '', vendor: channel?.vendor || '',
    poolIds: [...(channel?.poolIds || (channel?.poolId ? [channel.poolId] : []))],
    poolPriorities: { ...(channel?.poolPriorities || {}) },
    baseUrl: channel?.baseUrl || '', protocol: channel?.protocol || '', adapter: channel?.adapter || '',
    priority: channel?.priority ?? 0, weight: channel?.weight ?? 10, enabled: channel?.enabled ?? false,
    selected: parseModelList(channel?.models), discovered: [], added: [], observedAt: null,
    testModel: channel?.testModel || '', testResult: null,
    credentialAction: channel ? 'keep' : 'replace', credentialValue: '', credentialConfirmed: true,
    connectionRevision: 0, requestSerial: 0, pendingDiscovery: null, pendingTest: null,
    discoveryStatus: 'idle', discoveryError: '', saving: false, saveStatus: 'idle',
  };
}

export function setConnection(draft, patch) {
  const changed = ['baseUrl', 'protocol', 'adapter'].some((key) => key in patch && patch[key] !== draft[key]);
  if (!changed || draft.closed) return draft;
  return invalidateConnection({ ...draft, ...patch,
    credentialConfirmed: draft.credentialAction !== 'keep' });
}

function invalidateConnection(draft) {
  return { ...draft, connectionRevision: draft.connectionRevision + 1,
    discovered: [], added: [], observedAt: null, testResult: null,
    pendingDiscovery: null, pendingTest: null, discoveryStatus: 'idle', discoveryError: '' };
}

export function setCredential(draft, action, value = '') {
  if (!['keep', 'replace', 'clear'].includes(action)) throw new TypeError('凭据操作无效');
  if (action === 'keep' && !draft.channelId) throw new TypeError('新渠道需要填写凭据');
  if (draft.closed) return draft;
  const credentialValue = action === 'replace' ? value : '';
  if (action === draft.credentialAction && credentialValue === draft.credentialValue && draft.credentialConfirmed) return draft;
  return invalidateConnection({ ...draft, credentialAction: action, credentialValue, credentialConfirmed: true });
}

export function setSelectedModels(draft, values) {
  if (draft.closed) return draft;
  const selected = parseModelList(values);
  return { ...draft, selected, testModel: selected.includes(draft.testModel) ? draft.testModel : '',
    testResult: selected.includes(draft.testModel) ? draft.testResult : null };
}

export function addManualModels(draft, value) {
  return setSelectedModels(draft, [...draft.selected, ...parseModelList(value)]);
}

export function matchingModels(draft, search = '', filter = 'all') {
  const query = search.trim().toLowerCase();
  const selected = new Set(draft.selected), discovered = new Set(draft.discovered), added = new Set(draft.added);
  return [...new Set([...draft.discovered, ...draft.selected])].filter((id) =>
    id.toLowerCase().includes(query) && (filter === 'selected' ? selected.has(id)
      : filter === 'added' ? added.has(id) : filter === 'missing' ? draft.observedAt !== null && !discovered.has(id) : true));
}

export function selectFilteredModels(draft, search, filter, checked) {
  const selected = new Set(draft.selected);
  for (const id of matchingModels(draft, search, filter)) checked ? selected.add(id) : selected.delete(id);
  return setSelectedModels(draft, [...selected]);
}

export function modelPage(draft, search = '', filter = 'all', page = 0) {
  const matches = matchingModels(draft, search, filter);
  const lastPage = Math.max(0, Math.ceil(matches.length / 50) - 1);
  const current = Math.max(0, Math.min(page, lastPage));
  const selected = new Set(draft.selected), discovered = new Set(draft.discovered), added = new Set(draft.added);
  return { total: matches.length, page: current, lastPage,
    items: matches.slice(current * 50, current * 50 + 50).map((id) => ({ id, selected: selected.has(id),
      missing: draft.observedAt !== null && !discovered.has(id), added: added.has(id) })) };
}

export function beginDiscovery(draft) {
  if (draft.closed || !draft.credentialConfirmed) return { draft, token: null };
  const token = { sessionId: draft.sessionId, revision: draft.connectionRevision, serial: draft.requestSerial + 1 };
  return { draft: { ...draft, requestSerial: token.serial, pendingDiscovery: token, discoveryStatus: 'loading', discoveryError: '' }, token };
}

export function isCurrentDiscovery(draft, token) {
  return Boolean(token && !draft.closed && draft.pendingDiscovery?.serial === token.serial
    && draft.sessionId === token.sessionId && draft.connectionRevision === token.revision);
}

export function finishDiscovery(draft, token, { models = [], observedAt = new Date().toISOString(), error = '' } = {}) {
  if (!isCurrentDiscovery(draft, token)) return draft;
  const discovered = parseModelList(models);
  if (error || !discovered.length) return { ...draft, pendingDiscovery: null, discoveryStatus: 'error',
    discoveryError: error || '上游没有返回可用模型，已保留原目录和选择' };
  const previous = new Set(draft.discovered);
  return { ...draft, discovered, added: discovered.filter((id) => !previous.has(id)), observedAt,
    pendingDiscovery: null, discoveryStatus: 'ready', discoveryError: '' };
}

export function previewInput(draft, baseGen) {
  if (!draft.credentialConfirmed) throw new Error('请确认是否将已有凭据用于当前上游地址');
  if (draft.credentialAction === 'replace' && !draft.credentialValue) throw new Error('请填写新的 API Key');
  return { ...(draft.channelId ? { channelId: draft.channelId } : {}), ...(baseGen !== undefined ? { baseGen } : {}),
    baseUrl: draft.baseUrl, protocol: draft.protocol, credentialAction: draft.credentialAction,
    ...(draft.credentialAction === 'replace' ? { credentialValue: draft.credentialValue } : {}) };
}

export function beginSave(draft) {
  if (draft.closed || draft.saving) return draft;
  return { ...draft, saving: true, saveStatus: 'saving' };
}

export function finishSave(draft, status) {
  if (!['active', 'pending', 'failed', 'unknown'].includes(status)) throw new TypeError('保存状态无效');
  return draft.closed ? draft : { ...draft, saving: false, saveStatus: status };
}

// 409 有两种：配置整体已变化（保持原文案），以及同一 operationId 带着不同内容再次提交（operation_conflict）。
export function conflictMessage(error, fallback) {
  if (error.status !== 409) return error.message;
  return error.code === 'operation_conflict' ? '这次保存已用不同内容提交过，请关闭后重新打开再改' : fallback;
}

export function closeEditorDraft(draft) {
  return { ...draft, closed: true, credentialValue: '', pendingDiscovery: null, pendingTest: null,
    discovered: [], added: [], selected: [], testResult: null, saving: false };
}

// ---- "获取模型"弹窗的纯函数 ----
// 厂商归类规则移植自 New API rc25 web/src/features/channels/lib/model-categories.ts（AGPL-3.0，QuantumNous）。
const CATEGORY_RULES = [
  { name: 'Perplexity', keywords: ['perplexity', 'sonar-'] },
  { name: 'NVIDIA', keywords: ['nvidia/', 'nvidia.', 'nemotron'] },
  { name: 'OpenAI', keywords: ['openai/', 'openai.', 'gpt-', 'chatgpt-', 'codex-', 'dall-e-', 'whisper-', 'omni-moderation-', 'text-moderation-',
    'text-embedding-ada-', 'text-embedding-3-', 'text-ada-', 'text-babbage-', 'text-curie-', 'davinci-', 'babbage-', 'computer-use-preview', 'sora'],
  pattern: /(?:^|[/.:])(?:o(?:1|3|4)(?=$|[-.:])|tts-)/ },
  { name: 'Anthropic', keywords: ['anthropic', 'claude'] },
  { name: 'Gemini', keywords: ['gemini', 'gemma', 'learnlm', 'imagen', 'veo', 'nano-banana', 'palm-'], pattern: /(?:^|[/.:])aqa$/ },
  { name: 'xAI', keywords: ['x-ai/', 'xai/', 'xai-', 'grok'] },
  { name: 'DeepSeek', keywords: ['deepseek'] },
  { name: 'Qwen', keywords: ['qwen', 'qwq-', 'qvq-', 'tongyi', 'gte-'], pattern: /(?:^|[/.:])(?:text-embedding-v\d+|gui-plus|z-image)(?:$|[-_.:])/ },
  { name: 'Wan', pattern: /(?:^|[/.:])wan(?:x?\d|[-_])/ },
  { name: 'Moonshot', keywords: ['moonshot', 'kimi-'] },
  { name: 'MiniMax', keywords: ['minimax', 'abab', 'hailuo'], pattern: /^(?:t2v|i2v|s2v)-01(?:-|$)/ },
  { name: 'Doubao', keywords: ['doubao', 'volcengine', 'seedance', 'seedream', 'seed-1-'] },
  { name: 'Zhipu', keywords: ['zhipu', 'zai-org', 'thudm', 'chatglm', 'cogview', 'cogvideo'], pattern: /(?:^|[/._-])glm(?=$|[-._])/ },
  { name: 'Baidu', keywords: ['baidu', 'wenxin', 'ernie'] },
  { name: 'Yi', keywords: ['01-ai/'], pattern: /(?:^|[/.:])yi(?=$|[-_])/ },
  { name: 'iFlytek', keywords: ['iflytek', 'sparkdesk'] },
  { name: 'Tencent', keywords: ['tencent', 'hunyuan'], pattern: /(?:^|[/.:])hy\d*(?=$|[-_.:])/ },
  { name: 'Baichuan', keywords: ['baichuan'] },
  { name: 'InternLM', keywords: ['internlm'] },
  { name: 'StepFun', keywords: ['stepfun', 'step-'] },
  { name: 'MiMo', keywords: ['xiaomi', 'mimo-'] },
  { name: 'Mistral', keywords: ['mistral', 'mixtral', 'codestral', 'ministral', 'pixtral', 'magistral'] },
  { name: 'Meta', keywords: ['meta-llama', 'llama-', 'llama2', 'llama3'] },
  { name: 'Cohere', keywords: ['cohere', 'command-', 'c4ai-aya', 'aya-'], pattern: /(?:^|[/.:])command$/ },
  { name: 'Jina', keywords: ['jinaai', 'jina-'] },
  { name: 'BAAI', keywords: ['baai/', 'bge-'] },
  { name: 'Black Forest Labs', keywords: ['black-forest-labs', 'flux.'] },
  { name: 'Microsoft', keywords: ['microsoft/'], pattern: /(?:^|[/.:])phi(?=$|[-._])/ },
  { name: 'Amazon', keywords: ['amazon/', 'amazon.', 'nova-', 'titan-'] },
  { name: 'AI21 Labs', keywords: ['ai21', 'jamba'] },
  { name: 'Stability AI', keywords: ['stabilityai', 'stable-diffusion', 'stable-image', 'sdxl-'] },
  { name: 'Nous Research', keywords: ['nousresearch', 'hermes-'] },
  { name: '360 AI', keywords: ['360gpt', '360zhinao'] },
  { name: 'Midjourney', keywords: ['midjourney', 'mj_', 'mj-', 'swap_face'] },
  { name: 'Kling', keywords: ['kling'] },
  { name: 'Vidu', keywords: ['vidu'] },
  { name: 'Suno', keywords: ['suno'] },
  { name: 'Jimeng', keywords: ['jimeng'] },
];

export const OTHER_VENDOR = 'Other';

export function modelCategory(modelId) {
  const name = String(modelId).trim().toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords?.some((keyword) => name.includes(keyword)) || rule.pattern?.test(name)) return rule.name;
  }
  return OTHER_VENDOR;
}

// 配置里的 vendor 是小写标识（openai、anthropic、google…），显示名与移植规则的分组名对齐，避免同一厂商分成两组。
const VENDOR_LABELS = new Map([['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['google', 'Gemini'], ['gemini', 'Gemini'], ['xai', 'xAI'],
  ['deepseek', 'DeepSeek'], ['moonshot', 'Moonshot'], ['zhipu', 'Zhipu'], ['qwen', 'Qwen'], ['mistral', 'Mistral'], ['meta', 'Meta']]);
export function vendorLabel(vendor) {
  const key = String(vendor || '').trim();
  return key ? VENDOR_LABELS.get(key.toLowerCase()) || key : '';
}

// 已知模型优先用配置里的 vendor 归组，其余走移植的分组规则。vendors: Map(modelId -> vendor)。
export function modelVendor(modelId, vendors = new Map()) {
  return vendorLabel(vendors.get(modelId)) || modelCategory(modelId);
}

export function modelVendorId(modelId, vendors = new Map()) {
  if (vendors.get(modelId)) return vendors.get(modelId);
  const category = modelCategory(modelId);
  if (category === OTHER_VENDOR) return '';
  return [...VENDOR_LABELS].find(([, label]) => label === category)?.[0]
    || category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^(?=\d)/, 'vendor_');
}

// 组内保持传入（上游返回）顺序；组之间按厂商名 A→Z，Other 放最后。
export function groupModelsByVendor(ids, vendors = new Map()) {
  const groups = new Map();
  for (const id of ids) {
    const vendor = modelVendor(id, vendors);
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(id);
  }
  return [...groups].sort(([a], [b]) => (a === OTHER_VENDOR) - (b === OTHER_VENDOR)
    || a.localeCompare(b, 'en', { sensitivity: 'base' })).map(([vendor, models]) => ({ vendor, models }));
}

// 三个标签页：新增 = 上游返回但不在已选里；已有 = 上游返回且已在已选里；上游未返回 = 已选里有、上游没返回（沿用 matchingModels 的 missing 口径）。
// 不用 draft.added：首次拉取时它等于整个目录，"已有"会永远为空。search 不区分大小写，子串匹配。
export function fetchModelSets(draft, search = '') {
  const selected = new Set(draft.selected), query = search.trim().toLowerCase();
  const hit = (id) => id.toLowerCase().includes(query);
  return {
    new: draft.discovered.filter((id) => !selected.has(id) && hit(id)),
    existing: draft.discovered.filter((id) => selected.has(id) && hit(id)),
    removed: matchingModels(draft, search, 'missing'),
  };
}

export const FETCH_TABS = ['new', 'existing', 'removed'];

// 默认标签页：有新增停"新增"，否则有上游未返回停"上游未返回"，否则停"已有"。
export function defaultFetchTab(sets) {
  return sets.new.length ? 'new' : sets.removed.length ? 'removed' : 'existing';
}

// 当前标签页还有内容就留在原地，搜索把它筛空时回到默认规则。
export function resolveFetchTab(sets, current) {
  return current && sets[current]?.length ? current : defaultFetchTab(sets);
}

// 整组勾选只作用于传入的 ids（调用方传当前搜索结果里该组的成员）。
export function toggleModelGroup(selected, ids, checked) {
  const next = new Set(selected);
  for (const id of ids) checked ? next.add(id) : next.delete(id);
  return [...next];
}
