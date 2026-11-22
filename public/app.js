import { parseModelList } from './shared/model-list.js';
import { createEditorDraft, setConnection, setCredential, setSelectedModels, beginDiscovery, finishDiscovery, isCurrentDiscovery, closeEditorDraft } from './channel-editor/state.js';
import { mountModelPicker } from './channel-editor/model-picker.js';
import { openGatewayEditor } from './channel-editor/gateway-editor.js';
import { mountGatewayBilling } from './channel-editor/billing.js';
import { mountCallerManager } from './caller-editor/editor.js';

const state = {
  hours: 24,
  periodKey: 'today',
  overview: null,
  loading: false,
  pendingRefresh: null,
  settingsChannelId: null,
  settingsTab: 'config',
  settingsDraft: null,
  settingsEditor: null,
  createEditor: null,
  createModelPicker: null,
  gatewayMode: 'unknown',
  gatewayConfig: null,
  gatewayStatus: null,
  gatewaySession: null,
  gatewayMutation: false,
  gatewayProbing: new Set(),
  gatewayPendingOperation: null,
  gatewayHealth: null,
  gatewayHealthLoading: false,
  gatewayHealthStale: false,
  gatewayHealthPending: new Map(),
  callerManager: null,
  settingsTrigger: null,
  settingsConfirmResolve: null,
  walletCredentialCleared: false,
  rateLimitedUntil: 0,
  requestRateLimitedUntil: 0,
  requestLoading: false,
  requestPage: 1,
  requestPageData: null,
  requestCursors: [],
  requestCursorQuery: null,
  requestSummary: null,
  requestSummaryLoading: false,
  requestToken: 0,
  costDistributionMode: 'channel',
  trendChannelId: '',
  channelPriceModels: {},
  routingChannelId: null,
  routingPool: null,
  routingConfirmResolve: null,
  channelHealthSettings: null,
  costSyncSettings: null,
  renderedPeriodKey: null,
  lastRefreshAt: 0,
  page: null,
  pageDirty: {},
  pageScroll: {},
  pageVisited: new Set(),
  requestDetailTrigger: null,
};

const pageNames = ['overview', 'channels', 'requests', 'settings'];
// Only a fallback: the server always sends probeSettings. Must equal DEFAULT_PROBE_INTERVAL_MINUTES in src/channel-health-store.js (a test checks it).
const DEFAULT_PROBE_INTERVAL_MINUTES = 15;
const COOLDOWN_HINT = '同一渠道 5 分钟内第 3 次失败（或上游要求限流等待），之后一段时间新请求改走备用渠道';

const periodDefinitions = Object.freeze({
  today: { label: '今天', query: { period: 'today' }, hours: 24 },
  yesterday: { label: '昨天', query: { period: 'yesterday' }, hours: 24 },
  'hours-24': { label: '24 小时', query: { hours: 24 }, hours: 24 },
  'hours-168': { label: '7 天', query: { hours: 168 }, hours: 168 },
  'hours-720': { label: '30 天', query: { hours: 720 }, hours: 720 },
  'hours-2160': { label: '90 天', query: { hours: 2160 }, hours: 2160 },
  all: { label: '全部', query: { period: 'all' }, hours: 2160 },
});

function periodDefinition(key = state.periodKey) {
  return periodDefinitions[key] || periodDefinitions.today;
}

function periodQuery(key = state.periodKey) {
  return new URLSearchParams(Object.entries(periodDefinition(key).query).map(([name, value]) => [name, String(value)]));
}

function periodLabel(data = state.overview) {
  return data?.periodLabel || periodDefinition().label;
}

const $ = (selector) => document.querySelector(selector);
const elements = {
  overview: $('#main-content'),
  connection: $('#connection-state'),
  detail: $('#overview-detail'),
  refresh: $('#refresh-button'),
  requestRefresh: $('#request-refresh-button'),
  channelBody: $('#channel-body'),
  channelEmpty: $('#channel-empty'),
  requestBody: $('#request-body'),
  requestSummary: $('#request-summary'),
  requestSheetPeriods: $('#request-sheet-periods'),
  requestEmpty: $('#request-empty'),
  requestPagination: $('#request-pagination'),
  requestPageSummary: $('#request-page-summary'),
  requestPageCurrent: $('#request-page-current'),
  requestPageFirst: $('#request-page-first'),
  requestPagePrev: $('#request-page-prev'),
  requestPageNext: $('#request-page-next'),
  requestPageLast: $('#request-page-last'),
  modelList: $('#model-list'),
  modelTotal: $('#model-total'),
  trendChart: $('#trend-chart'),
  trendChannel: $('#trend-channel'),
  trendSummary: $('#trend-summary'),
  channelFilter: $('#channel-filter'),
  poolFilter: $('#pool-filter'),
  modelFilter: $('#model-filter'),
  streamFilter: $('#stream-filter'),
  statusFilter: $('#status-filter'),
  upstreamAlert: $('#upstream-alert'),
  upstreamAlertTitle: $('#upstream-alert-title'),
  upstreamAlertDetail: $('#upstream-alert-detail'),
  viewUpstreamErrors: $('#view-upstream-errors'),
  channelHealthSettingsButton: $('#channel-health-settings-button'),
  walletRefreshAll: $('#wallet-refresh-all'),
  settingsWalletRefresh: $('#settings-wallet-refresh-all'),
  requestDetailDialog: $('#request-detail-dialog'),
  pricingSummary: $('#pricing-page-summary'),
  pricingSyncBody: $('#pricing-sync-body'),
  pricingSyncEmpty: $('#pricing-sync-empty'),
  channelDialog: $('#channel-dialog'),
  channelSettingsDialog: $('#channel-settings-dialog'),
  channelSettingsPanel: $('#channel-settings-panel'),
  channelSettingsConfigTab: $('#channel-settings-config-tab'),
  channelSettingsWalletTab: $('#channel-settings-wallet-tab'),
  channelSettingsConfirm: $('#channel-settings-confirm'),
  routingConfirmDialog: $('#routing-confirm-dialog'),
  routingConfirmMessage: $('#routing-confirm-message'),
  toast: $('#toast'),
};

const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'CNY', currencyDisplay: 'narrowSymbol', maximumFractionDigits: 6 });
const multiplier = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
const requestPageSize = 100;
const reasoningLevels = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const channelColors = {
  anthropic: ['#d4a06c', '#f4d2af', '#cab47c', '#f2b1d9', '#cdc284'],
  openai: ['#62cfe0', '#6dd6d2', '#80e5e5', '#88e7d4', '#96e8ec'],
  gemini: ['#799aec', '#9093ea', '#67a6e9', '#72abd5', '#949fd1'],
  xai: ['#b8c4d6', '#82d9ca', '#ecb5ed', '#8be7ee', '#d6d499'],
  deepseek: ['#b69df1', '#bd90ea', '#b496d9', '#e3a6f2', '#b282ed'],
  unknown: ['#c0afb2', '#b8a0ba', '#a8b8a0', '#a0adb8', '#c0b4a0'],
};

const modelProviderRules = [
  ['Claude', (name) => name.includes('claude')],
  ['OpenAI', (name) => /^(gpt|chatgpt|codex|text-embedding|dall-e|whisper|tts)/.test(name) || /^o\d/.test(name)],
  ['Gemini', (name) => name.includes('gemini') || name.includes('gemma')],
  ['xAI', (name) => name.includes('grok')],
  ['DeepSeek', (name) => name.includes('deepseek')],
  ['Moonshot', (name) => name.includes('kimi') || name.includes('moonshot')],
  ['Zhipu', (name) => name.includes('glm') || name.includes('chatglm')],
];

function modelProviderOf(channel) {
  const counts = new Map();
  for (const model of channel?.models || []) {
    const name = String(model?.name ?? model?.id ?? model ?? '').toLowerCase();
    const rule = modelProviderRules.find(([, match]) => match(name));
    if (rule) counts.set(rule[0], (counts.get(rule[0]) || 0) + 1);
  }
  let best = null;
  for (const [provider, count] of counts) {
    if (best === null || count > counts.get(best)) best = provider;
  }
  return best || channel?.routingPool || '其他';
}

const providerLabelFamily = { Claude: 'anthropic', OpenAI: 'openai', Gemini: 'gemini', xAI: 'xai', DeepSeek: 'deepseek' };

function providerFamilyOf(channel) {
  if (channel && typeof channel === 'object' && Array.isArray(channel.models) && channel.models.length) {
    return providerLabelFamily[modelProviderOf(channel)] || 'unknown';
  }
  const type = String(channel?.providerFamily || channel?.type || '').toLowerCase();
  return type.includes('xai') || type.includes('grok')
    ? 'xai'
    : type.includes('anthropic') || type.includes('claude')
      ? 'anthropic'
      : type.includes('gemini')
        ? 'gemini'
        : type.includes('deepseek')
          ? 'deepseek'
          : type.includes('openai')
            ? 'openai'
            : 'unknown';
}

function channelColor(channelId, providerFamily = '') {
  const allChannels = state.overview?.channels || [];
  const found = allChannels.find((channel) => String(channel.id) === String(channelId));
  const family = found ? providerFamilyOf(found) : providerFamily;
  const channels = allChannels
    .filter((channel) => !family || providerFamilyOf(channel) === family)
    .sort((left, right) => Number(left.id) - Number(right.id));
  const index = channels.findIndex((channel) => String(channel.id) === String(channelId));
  const colors = channelColors[family] || channelColors.unknown;
  if (index >= 0) return colors[index % colors.length];
  const numericId = Number(channelId);
  return colors[Number.isFinite(numericId) ? Math.abs(numericId) % colors.length : 0];
}
function applyChannelColor(element, channelId, providerFamily = '') {
  element.style.setProperty('--channel-color', channelColor(channelId, providerFamily));
  return element;
}

function text(value) {
  return value === null || value === undefined || value === '' ? '' : String(value);
}

function formatTokens(value) {
  return value === null || value === undefined ? '' : compact.format(value);
}

function formatMoney(value) {
  return value === null || value === undefined ? '' : money.format(value);
}

function formatCost(value) {
  return formatMoney(value);
}

// 请求页合计：USD 沿用页面金额格式，其他币种用 Intl 的币种格式；lowerBound 时整体加 ≥。
const currencyFormats = new Map();
function formatCurrencyAmount(currency, amount) {
  if (currency === 'USD' || currency === 'CNY') return formatMoney(amount);
  if (!currencyFormats.has(currency)) {
    try { currencyFormats.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 6 })); }
    catch { currencyFormats.set(currency, null); }
  }
  const format = currencyFormats.get(currency);
  return format ? format.format(amount) : `${decimal.format(amount)} ${currency}`;
}

// 核心把客户端中途断开记成 request_outcome "cancelled"：请求没成功，但不是上游错误。
function isClientCancelled(log) {
  return log?.requestOutcome === 'cancelled';
}

// Numeric ids compare by value ("2" before "1012"); anything else falls back to string order.
function compareChannelIds(left, right) {
  const numeric = (value) => /^\d+$/.test(String(value));
  return numeric(left) && numeric(right) ? Number(left) - Number(right) : String(left).localeCompare(String(right));
}

function requestSummaryText(summary, loading = false) {
  if (loading) return '合计 …';
  if (!summary || !Array.isArray(summary.costs)) return '';
  const costs = summary.costs.length ? summary.costs : [{ currency: 'USD', amount: 0 }];
  const count = Number.isSafeInteger(summary.requests) ? `${decimal.format(summary.requests)} 条 · ` : '';
  return `合计 ${count}${summary.lowerBound ? '≥ ' : ''}${costs.map((item) => formatCurrencyAmount(item.currency, item.amount)).join(' · ')}`;
}

function renderRequestSummary() {
  const text = requestSummaryText(state.requestSummary, state.requestSummaryLoading);
  elements.requestSummary.hidden = !text;
  elements.requestSummary.textContent = text;
  elements.requestSummary.classList.toggle('is-loading', state.requestSummaryLoading);
}

function formatMs(value) {
  if (value === null || value === undefined) return '';
  return value >= 1000 ? `${decimal.format(value / 1000)} s` : `${decimal.format(value)} ms`;
}

function formatTime(value, short = false) {
  if (!value) return '';
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-CN', short
    ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function showToast(message, tone = 'normal', durationMs = 3200) {
  elements.toast.textContent = message;
  elements.toast.dataset.tone = tone;
  elements.toast.classList.add('visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove('visible'), durationMs);
}

let activeTooltip = null;

function hideFloatingTooltip() {
  activeTooltip?.remove();
  activeTooltip = null;
}

function showOverflowTooltip(target) {
  const fullText = target.dataset.fullText;
  if (!fullText || target.scrollWidth <= target.clientWidth) return;
  hideFloatingTooltip();
  const tooltip = document.createElement('div');
  tooltip.className = 'floating-tooltip';
  tooltip.textContent = fullText;
  document.body.append(tooltip);
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gutter = 12;
  const left = Math.min(
    window.innerWidth - tooltipRect.width - gutter,
    Math.max(gutter, targetRect.left),
  );
  let top = targetRect.top - tooltipRect.height - 8;
  if (top < gutter) top = targetRect.bottom + 8;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
  activeTooltip = tooltip;
}

function enableOverflowTooltip(target) {
  target.dataset.fullText = target.textContent;
  target.title = target.textContent;
  target.classList.add('tooltip-source');
  target.addEventListener('mouseenter', () => showOverflowTooltip(target));
  target.addEventListener('mouseleave', hideFloatingTooltip);
}

window.addEventListener('scroll', hideFloatingTooltip, true);
window.addEventListener('resize', hideFloatingTooltip);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    if (payload.error?.code) error.code = payload.error.code;
    throw error;
  }
  return payload;
}

function cell(value, className = '') {
  const td = document.createElement('td');
  td.className = className;
  if (value instanceof Node) td.append(value);
  else td.textContent = text(value);
  return td;
}

function statusNode(channel) {
  const wrapper = document.createElement('span');
  wrapper.className = `status status-${channel.state}`;
  const dot = document.createElement('i');
  const label = document.createElement('span');
  label.textContent = channel.state === 'exhausted' ? '余额耗尽'
    : channel.state === 'auth_invalid' ? '凭据失效'
    : channel.state === 'failing'
    ? '报错中'
    : channel.state === 'recovered'
      ? '已恢复'
      : channel.state === 'unknown' && channel.enabled
        ? '待验证'
      : channel.enabled
        ? '可用'
        : '停用';
  wrapper.append(dot, label);
  return wrapper;
}

function channelIdentity(channel) {
  const wrapper = document.createElement('div');
  wrapper.className = 'identity channel-identity';
  applyChannelColor(wrapper, channel.id, providerFamilyOf(channel));
  const strong = document.createElement('strong');
  strong.textContent = channel.name;
  const small = document.createElement('small');
  const type = document.createElement('span');
  type.textContent = `${channel.type} · #${channel.id}`;
  small.append(type, statusNode(channel));
  wrapper.append(strong, small);
  return wrapper;
}

function modelPills(models) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pill-list';
  // 展示全部模型，每行一个标签；单个长名称保留完整提示。
  for (const model of models) {
    const pill = document.createElement('span');
    pill.textContent = model;
    pill.title = model;
    wrapper.append(pill);
  }
  return wrapper;
}

function routeMetrics(channel) {
  const wrapper = document.createElement('div');
  wrapper.className = 'route-metrics';
  if (state.gatewayMode === 'gateway' && channel.poolRoles?.length) {
    for (const role of channel.poolRoles) wrapper.append(routeMetrics({ ...channel, ...role, poolRoles: null }));
    return wrapper;
  }
  if (state.gatewayMode === 'gateway') {
    const label = channel.position === 1 ? '主用' : `第${channel.position}`;
    const control = document.createElement('div');
    control.className = `route-position-control route-role-${channel.routeRole}`;
    const dot = document.createElement('i');
    dot.className = 'route-position-dot';
    dot.setAttribute('aria-hidden', 'true');
    const select = document.createElement('select');
    select.className = 'route-position';
    select.setAttribute('aria-label', `${channel.name}在${channel.routingPool}分组的顺位`);
    for (let position = 1; position <= channel.poolSize; position++) {
      const option = document.createElement('option');
      option.value = String(position);
      option.textContent = position === 1 ? '主用' : `第${position}`;
      select.append(option);
    }
    select.value = String(channel.position);
    select.disabled = !channel.enabled || state.gatewayMutation || Boolean(state.gatewayPendingOperation) || state.routingChannelId !== null;
    select.addEventListener('change', async () => {
      try { await setChannelPosition(channel, channel.poolId, Number(select.value)); }
      finally { select.value = String(channel.position); }
    });
    control.append(dot, select);
    if (!channel.enabled) {
      const disabledTag = document.createElement('span');
      disabledTag.className = 'route-disabled-tag';
      disabledTag.textContent = `已禁用 · ${label}`;
      control.append(disabledTag);
    }
    const summary = document.createElement('span');
    summary.className = 'route-config';
    summary.textContent = `${channel.routingPool} 分组 · 共 ${channel.poolSize} 个渠道`;
    const isClaude = [channel.poolId, channel.routingPool].some((value) => String(value).toLowerCase() === 'claude');
    summary.title = isClaude ? 'Claude 只使用配置主用，失败直接返回错误；其余顺位仅供手动切换'
      : '按配置顺位，结合模型支持与健康状态选择渠道；停用渠道不参与请求';
    wrapper.append(control, summary);
    return wrapper;
  }
  const stateLine = document.createElement('div');
  stateLine.className = 'route-state-line';
  const role = document.createElement('span');
  role.className = `route-role route-role-${channel.routeRole}`;
  if (!channel.enabled) {
    role.textContent = '已禁用';
    role.title = '渠道已禁用，启用后才能调整路由';
  } else if (channel.isSolePrimary) {
    role.textContent = '当前主用';
    role.title = channel.routingPool === 'claude' ? 'Claude 固定主用，失败直接返回错误，仅手动切换' : `${channel.routingPool} 分组唯一最高优先级；仅对该渠道支持的模型生效`;
  } else if (channel.routeRole === 'primary') {
    role.textContent = channel.routingPool === 'claude' ? '主用层（仅手动切换）' : channel.configWeightShare === null
      ? '主用层'
      : `主用层 · ${decimal.format(channel.configWeightShare * 100)}% 配置份额`;
    role.title = channel.routingPool === 'claude' ? 'Claude 同优先级按渠道 ID 固定选择，不轮询、不自动切换' : '同主用层按权重配置分配，实际流量受模型支持和健康状态影响';
  } else {
    role.textContent = '备用';
    role.title = channel.routingPool === 'claude' ? 'Claude 备用渠道仅供手动切换，不参与自动故障转移' : `当前位于 ${channel.routingPool} 分组备用层，自动故障转移仍然生效`;
  }
  stateLine.append(role);
  if (channel.enabled && !channel.isSolePrimary) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = `route-primary-action${channel.state === 'failing' ? ' route-primary-warning' : ''}`;
    action.textContent = channel.routeRole === 'primary' ? '设为唯一主用' : '设为主用';
    action.title = `提升为 ${channel.routingPool} 分组唯一最高优先级；仅对支持的 ${channel.models.length} 个模型生效`;
    action.disabled = state.routingPool === channel.routingPool;
    if (state.routingChannelId === channel.id) action.textContent = '切换中...';
    action.addEventListener('click', () => setPrimaryChannel(channel, channel.poolId));
    stateLine.append(action);
  }
  const summary = document.createElement('span');
  summary.className = 'route-config';
  summary.textContent = `${channel.routingPool} 分组 · 权重 ${decimal.format(channel.weight)} · 优先级 ${channel.priority}`;
  summary.title = '优先级决定故障转移顺序；权重只在同优先级内参与配置分配';
  wrapper.append(stateLine, summary);
  return wrapper;
}

function resolveRoutingConfirm(result) {
  if (!state.routingConfirmResolve) return;
  const resolve = state.routingConfirmResolve;
  state.routingConfirmResolve = null;
  elements.routingConfirmDialog.close();
  resolve(result);
}

function confirmUnhealthyPrimary(channel) {
  if (state.routingConfirmResolve) resolveRoutingConfirm(false);
  elements.routingConfirmMessage.textContent = `${channel.name} 最近一次自动探活失败。将它设为主用可能继续失败。`;
  elements.routingConfirmDialog.showModal();
  return new Promise((resolve) => { state.routingConfirmResolve = resolve; });
}

function channelQuality(channel) {
  const wrapper = document.createElement('div');
  wrapper.className = 'quality-cell';
  if (state.gatewayMode === 'gateway' && !Array.isArray(channel.recentProbes)) {
    wrapper.textContent = channel.enabled ? '检测待联调 · 尚无验证结果' : '已停用 · 检测待联调';
    return wrapper;
  }
  const heading = document.createElement('div');
  heading.className = 'availability-heading';
  const latency = document.createElement('strong');
  latency.textContent = channel.probeAverageLatencyMs === null || channel.probeAverageLatencyMs === undefined
    ? ''
    : `均 ${formatMs(channel.probeAverageLatencyMs)}`;
  latency.title = `${channel.probePeriodHours} 小时自动探活平均延迟`;
  const rate = document.createElement('span');
  rate.className = 'availability-rate';
  if (channel.probeSuccessRate === null) {
    rate.textContent = channel.enabled ? '等待探活' : '已停用';
    rate.classList.add('availability-empty');
  } else {
    const percentage = channel.probeSuccessRate * 100;
    rate.textContent = `${decimal.format(percentage)}%`;
    rate.classList.add(percentage >= 98 ? 'availability-good' : percentage >= 85 ? 'availability-warning' : 'availability-bad');
  }
  heading.append(latency, rate);

  const summary = document.createElement('span');
  summary.className = 'availability-summary';
  summary.textContent = channel.probeAttempts > 0
    ? `${channel.probePeriodHours}h 探活 ${channel.probeSuccesses}/${channel.probeAttempts} · 最近 ${formatTime(channel.lastProbeAt)}`
    : channel.enabled && state.gatewayMode === 'gateway' && channel.probeModel === null
      ? '没有可探测的模型 · 不会自动探活'
    : channel.enabled
      ? `每 ${channel.probeIntervalMinutes} 分钟自动检测 · 尚无结果`
      : '渠道已停用 · 不执行自动探活';
  summary.title = [
    state.gatewayMode === 'gateway'
      ? `后台每 ${channel.probeIntervalMinutes} 分钟经网关向上游发一次最小请求`
      : `后台每 ${channel.probeIntervalMinutes} 分钟调用一次 New API 渠道检测`,
    state.gatewayMode === 'gateway'
      ? `检测模型 ${channel.probeModel || '无'}${channel.probeModel && !channel.testModel ? '（未设置，取第一个可探测模型）' : ''}${channel.probeProtocol ? ` · ${channel.probeProtocol} · 非流式` : ''}`
      : `检测模型 ${channel.testModel || '渠道首个模型'}`,
    '结果独立于真实业务请求',
    channel.lastProbeSuccess === false ? (channel.lastProbeMessage || '最近一次探活失败') : '',
  ].filter(Boolean).join(' · ');

  const strip = document.createElement('div');
  strip.className = 'availability-strip';
  strip.setAttribute('aria-label', `最近 ${channel.recentProbes.length} 次自动探活结果`);
  const emptySlots = Math.max(0, 60 - channel.recentProbes.length);
  for (let index = 0; index < emptySlots; index += 1) {
    const slot = document.createElement('i');
    slot.className = 'availability-event availability-event-empty';
    strip.append(slot);
  }
  for (const result of channel.recentProbes) {
    const event = document.createElement('i');
    event.className = `availability-event ${result.success ? 'availability-event-success' : 'availability-event-error'}`;
    event.title = [
      result.source === 'manual' ? '手动检测' : '',
      result.success ? '成功' : (result.statusCode ? `HTTP ${result.statusCode}` : '失败'),
      result.model || '',
      result.latencyMs === null ? '' : formatMs(result.latencyMs),
      result.checkedAt ? formatTime(result.checkedAt) : '',
      result.message || '',
    ].filter(Boolean).join(' · ');
    strip.append(event);
  }
  wrapper.append(heading, summary);
  if (channel.cooldowns > 0) {
    const cooldown = document.createElement('span');
    cooldown.className = 'availability-cooldown';
    cooldown.textContent = `冷却 ${decimal.format(channel.cooldowns)} 次`;
    cooldown.title = COOLDOWN_HINT;
    wrapper.append(cooldown);
  }
  wrapper.append(strip);
  return wrapper;
}

function currentChannelHealthSettings() {
  const settings = state.channelHealthSettings || state.overview?.probeSettings;
  if (settings) return settings;
  const intervalMinutes = Number(state.overview?.channels?.find((channel) => channel.probeIntervalMinutes)?.probeIntervalMinutes) || DEFAULT_PROBE_INTERVAL_MINUTES;
  return { probeIntervalMinutes: intervalMinutes, minProbeIntervalMinutes: 1, maxProbeIntervalMinutes: 1440 };
}

function syncChannelHealthSettingsForm({ force = false } = {}) {
  const input = $('#channel-health-interval');
  if (!input || (!force && document.activeElement === input)) return;
  const settings = currentChannelHealthSettings();
  input.min = String(settings.minProbeIntervalMinutes);
  input.max = String(settings.maxProbeIntervalMinutes);
  input.value = String(settings.probeIntervalMinutes);
}

async function openChannelHealthSettings() {
  if (!state.overview?.probeSettings) {
    try {
      state.channelHealthSettings = await api('/api/settings/probes');
    } catch (error) {
      showToast(error.message, 'error');
      return;
    }
  }
  window.location.hash = '#settings';
  routeFromHash();
  const runtimeTab = $('#settings-runtime-tab');
  if (runtimeTab && typeof selectSettingsPageTab === 'function') selectSettingsPageTab(runtimeTab);
  syncChannelHealthSettingsForm({ force: true });
  $('#channel-health-settings-status').textContent = '';
  $('#channel-health-interval').focus();
}

async function saveChannelHealthSettings(event) {
  event.preventDefault();
  const input = $('#channel-health-interval');
  const status = $('#channel-health-settings-status');
  const button = $('#save-channel-health-settings');
  const value = Number(input.value);
  const minimum = Number(input.min);
  const maximum = Number(input.max);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    status.textContent = `请输入 ${minimum} 到 ${maximum} 的整数分钟数`;
    return;
  }
  button.disabled = true;
  status.textContent = '';
  try {
    const settings = await api('/api/settings/probes', {
      method: 'PUT',
      body: JSON.stringify({ probeIntervalMinutes: value }),
    });
    state.channelHealthSettings = settings;
    if (state.overview) {
      state.overview.probeSettings = settings;
      for (const channel of state.overview.channels || []) channel.probeIntervalMinutes = settings.probeIntervalMinutes;
      renderChannels();
    }
    syncChannelHealthSettingsForm({ force: true });
    status.textContent = `已保存，每 ${settings.probeIntervalMinutes} 分钟探活一次`;
    showToast(`自动探活已调整为每 ${settings.probeIntervalMinutes} 分钟一次`);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function syncCostSyncSettingsForm({ force = false } = {}) {
  const input = $('#cost-sync-interval');
  if (!input || (!force && document.activeElement === input)) return;
  const settings = state.costSyncSettings || state.overview?.costSyncSettings;
  if (!settings) return;
  input.min = String(settings.minCostSyncIntervalMinutes);
  input.max = String(settings.maxCostSyncIntervalMinutes);
  input.value = String(settings.costSyncIntervalMinutes);
}

async function saveCostSyncSettings(event) {
  event.preventDefault();
  const input = $('#cost-sync-interval');
  const status = $('#cost-sync-settings-status');
  const button = $('#save-cost-sync-settings');
  const value = Number(input.value);
  const minimum = Number(input.min);
  const maximum = Number(input.max);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    status.textContent = `请输入 ${minimum} 到 ${maximum} 的整数分钟数`;
    return;
  }
  button.disabled = true;
  status.textContent = '';
  try {
    const settings = await api('/api/settings/cost-sync', {
      method: 'PUT', body: JSON.stringify({ costSyncIntervalMinutes: value }),
    });
    state.costSyncSettings = settings;
    if (state.overview) state.overview.costSyncSettings = settings;
    syncCostSyncSettingsForm({ force: true });
    status.textContent = `已保存，倍率拉取间隔为 ${settings.costSyncIntervalMinutes} 分钟`;
    showToast(`倍率拉取间隔已调整为 ${settings.costSyncIntervalMinutes} 分钟`);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// Keys are the error_class values of billing_probe_response (contracts/v1/internal-api.schema.json),
// plus the codes this console adds itself when the core cannot be reached.
const costSyncErrorNames = {
  unauthorized: '上游拒绝凭据',
  probe_rate_limited: '探测过于频繁',
  group_unresolved: '未能识别分组',
  endpoint_unsupported: '上游没有倍率接口',
  channel_type_unsupported: '该渠道类型不支持',
  channel_proxy_unsupported: '渠道代理不支持探测',
  key_unavailable: '渠道密钥不可用',
  invalid_target: '上游地址无效',
  target_blocked: '上游地址被安全策略拦截',
  dns_error: '上游域名解析失败',
  tls_error: '上游 TLS 连接失败',
  timeout: '查询上游超时',
  network_error: '上游网络错误',
  redirect_blocked: '上游重定向被拒绝',
  http_4xx: '上游返回 4xx',
  http_5xx: '上游 5xx',
  bad_content_type: '上游响应格式不对',
  response_too_large: '上游响应过大',
  response_read_error: '读取上游响应失败',
  schema_invalid: '上游倍率格式异常',
  value_out_of_band: '上游倍率超出合法范围',
  probe_failed: '同步失败',
  probe_request_failed: '本地探测请求失败',
  gateway_unavailable: '网关核心不可用',
  gateway_timeout: '等待核心查询结果超时',
};

// Own properties only: an error class is data, so "constructor" must not resolve to Object's.
function costSyncErrorName(errorClass) {
  return Object.hasOwn(costSyncErrorNames, errorClass) ? costSyncErrorNames[errorClass] : null;
}

function costSyncErrorDetail(sync = {}) {
  return costSyncErrorName(sync.errorClass) || '同步失败';
}

function channelModelPrice(channel) {
  const wrapper = document.createElement('div');
  wrapper.className = 'channel-model-price';
  const models = channel.models || [];
  if (!models.length) {
    wrapper.textContent = '未配置模型';
    return wrapper;
  }
  const selected = state.channelPriceModels[channel.id];
  state.channelPriceModels[channel.id] = models.includes(selected) ? selected : models[0];
  const details = document.createElement('div');
  const renderPrice = () => {
    const model = state.channelPriceModels[channel.id];
    const pricing = state.overview?.pricingCatalog?.find((entry) => entry.model === model);
    const rateMultiplier = pricing?.channelMultipliers
      ? pricing.channelMultipliers[channel.id]
      : channel.costMultiplier;
    const unit = document.createElement('small');
    unit.textContent = `CNY / 百万 Token · ${Number.isFinite(rateMultiplier) ? `${multiplier.format(rateMultiplier)}×` : '倍率未配置'}`;
    unit.title = [pricing?.priceSource, pricing?.maxContextTokens ? `适用上下文 ≤ ${decimal.format(pricing.maxContextTokens)} Token` : ''].filter(Boolean).join(' · ');
    const rates = document.createElement('div');
    rates.className = 'channel-price-rates';
    for (const [key, label] of [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写']]) {
      const item = document.createElement('div');
      const name = document.createElement('span');
      name.textContent = label;
      const value = document.createElement('b');
      const rate = pricing?.rates?.[key];
      value.textContent = Number.isFinite(rate) && Number.isFinite(rateMultiplier) ? money.format(rate * rateMultiplier) : '—';
      value.title = value.textContent === '—' ? '暂无可确认价格' : `${money.format(rate)} × ${multiplier.format(rateMultiplier)}`;
      if (value.textContent === '—') value.className = 'is-none';
      item.append(name, value);
      rates.append(item);
    }
    details.replaceChildren(unit, rates);
  };
  if (models.length > 1) {
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${channel.name} 折算价格模型`);
    for (const model of models) select.add(new Option(model, model));
    select.value = state.channelPriceModels[channel.id];
    select.title = select.value;
    select.addEventListener('change', () => {
      state.channelPriceModels[channel.id] = select.value;
      select.title = select.value;
      renderPrice();
    });
    wrapper.append(select);
  } else {
    const model = document.createElement('span');
    model.className = 'channel-price-model';
    model.textContent = models[0];
    model.title = models[0];
    wrapper.append(model);
  }
  renderPrice();
  wrapper.append(details);
  return wrapper;
}

function costSummary(channel) {
  const wrapper = document.createElement('div');
  wrapper.className = 'cost-summary';
  const content = document.createElement('div');
  const value = document.createElement('strong');
  value.textContent = channel.costMultiplier === null ? '' : `${multiplier.format(channel.costMultiplier)} ×`;
  const note = document.createElement('small');
  const sync = channel.costSync || { mode: 'manual', status: 'manual' };
  note.className = `sync-note sync-${sync.status}`;
  if (sync.mode === 'manual') {
    note.textContent = sync.status === 'identity_changed' ? '渠道地址或类型变化 · 已转手动' : '手动倍率';
  } else if (sync.errorClass === 'probe_rate_limited') {
    note.textContent = '刚刚已探测 · 当前值未变';
  } else if (sync.status === 'synced') {
    note.textContent = [
      '自动同步',
      sync.upstreamGroup ? `分组：${sync.upstreamGroup}` : '',
      formatTime(sync.lastSuccessAt, true),
    ].filter(Boolean).join(' · ');
  } else if (sync.status === 'unsupported') {
    note.textContent = `${costSyncErrorName(sync.errorClass) || '上游不支持'} · 保留当前值`;
  } else if (sync.status === 'error') {
    note.textContent = `${costSyncErrorDetail(sync)} · 保留当前值`;
  } else {
    note.textContent = '自动同步 · 等待刷新';
  }
  enableOverflowTooltip(note);
  if (sync.mode === 'auto' && (sync.status === 'error' || sync.status === 'unsupported') && sync.errorClass) {
    // The visible note stays short; hovering also gives the raw class and the last attempt.
    const detail = [note.textContent, `错误码：${sync.errorClass}`,
      sync.lastAttemptAt ? `最近尝试：${formatTime(sync.lastAttemptAt, true)}` : ''].filter(Boolean).join(' · ');
    note.title = detail;
    note.dataset.fullText = detail;
  }
  content.append(value, note);
  wrapper.append(content);
  if (sync.mode === 'auto') {
    const refreshButton = document.createElement('button');
    refreshButton.type = 'button';
    refreshButton.className = 'cost-sync-refresh';
    refreshButton.textContent = '↻';
    refreshButton.title = `立即同步 ${channel.name} 上游倍率`;
    refreshButton.setAttribute('aria-label', refreshButton.title);
    refreshButton.addEventListener('click', () => refreshCostMultiplier(channel, refreshButton));
    wrapper.append(refreshButton);
  }
  return wrapper;
}

const walletAdapterNames = {
  auto: '自动识别',
  newapi: 'New API',
  sub2: 'Sub2',
  rightcode: 'Right Code',
  none: '不检测',
};

const walletErrorNames = {
  edge_blocked: '被上游 Cloudflare/WAF 拦截',
  unauthorized: '授权凭据被上游拒绝',
  needs_reauth: '凭据无效、过期或已轮换',
  unlimited_quota: '令牌不限额，请填访问令牌读账户余额',
  endpoint_unsupported: '上游未开放余额接口',
  schema_invalid: '上游余额接口响应不兼容',
  bad_content_type: '上游返回网页而非 API 数据',
  timeout: '上游响应超时',
  network_error: '无法连接上游',
  dns_error: '上游域名解析失败',
  tls_error: '上游 TLS 连接失败',
  http_4xx: '上游拒绝余额请求',
  http_5xx: '上游余额服务异常',
  target_blocked: '余额地址不符合安全规则',
  probe_failed: '上游余额探测失败',
};

function walletStatusDetail(wallet = {}) {
  if (wallet.adapter === 'none') return '不检测';
  if (wallet.status === 'unconfigured') return '需配置凭据';
  if (wallet.status === 'needs_reauth') return walletErrorNames[wallet.errorClass] || walletErrorNames.needs_reauth;
  if (wallet.status === 'error') return walletErrorNames[wallet.errorClass] || '同步失败';
  if (wallet.status === 'unsupported') return '未识别';
  return '等待同步';
}

function formatBalance(wallet) {
  if (wallet.errorClass === 'unlimited_quota') return '令牌不限额';
  if (wallet.balance === null || wallet.balance === undefined) return '';
  if (wallet.currency === 'USD') return formatMoney(wallet.balance);
  const value = decimal.format(wallet.balance);
  return wallet.currency ? `${value} ${wallet.currency}` : value;
}

function walletSummary(channel, onOpen = (trigger) => openChannelSettings(channel, 'wallet', trigger)) {
  const wallet = channel.wallet || {};
  const wrapper = document.createElement('div');
  wrapper.className = `wallet-summary wallet-${wallet.status || 'unknown'}`;
  const content = document.createElement('button');
  content.type = 'button';
  content.className = 'wallet-summary-open';
  content.title = `打开 ${channel.name} 上游余额设置`;
  const value = document.createElement('strong');
  value.textContent = formatBalance(wallet);
  if (wallet.errorClass === 'unlimited_quota') value.className = 'is-neutral';
  const note = document.createElement('small');
  const adapter = walletAdapterNames[wallet.detectedAdapter || wallet.adapter] || '';
  if (wallet.status === 'ok') note.textContent = [adapter, formatTime(wallet.fetchedAt, true)].filter(Boolean).join(' · ');
  else note.textContent = [adapter, walletStatusDetail(wallet)].filter(Boolean).join(' · ');
  content.append(value, note);
  content.addEventListener('click', (event) => onOpen(event.currentTarget));
  const refreshButton = document.createElement('button');
  refreshButton.type = 'button';
  refreshButton.className = 'wallet-refresh';
  refreshButton.textContent = '↻';
  refreshButton.title = `刷新 ${channel.name} 上游余额`;
  refreshButton.setAttribute('aria-label', refreshButton.title);
  refreshButton.addEventListener('click', () => refreshWallet(channel, refreshButton));
  const actions = document.createElement('div');
  actions.className = 'wallet-summary-actions';
  if (wallet.status === 'unconfigured' || wallet.status === 'needs_reauth') {
    const authorize = document.createElement('button');
    authorize.type = 'button';
    authorize.className = 'text-button';
    authorize.textContent = wallet.status === 'needs_reauth' ? '重新授权' : '授权';
    authorize.addEventListener('click', (event) => onOpen(event.currentTarget));
    actions.append(authorize);
  }
  actions.append(refreshButton);
  wrapper.append(content, actions);
  return wrapper;
}

function configDraft(channel) {
  return {
    weight: String(channel.weight),
    priority: String(channel.priority),
    modelsText: channel.models.join(', '),
    testModel: channel.testModel || channel.models[0] || '',
    multiplier: channel.costMultiplier === null ? '' : String(channel.costMultiplier),
    costSyncMode: channel.costSync?.mode === 'auto' ? 'auto' : 'manual',
  };
}

function walletDraft(channel) {
  const wallet = channel.wallet || {};
  const detectedCredentialAdapter = ['newapi', 'sub2', 'rightcode'].includes(wallet.detectedAdapter) ? wallet.detectedAdapter : null;
  return {
    adapter: wallet.adapter === 'auto' && detectedCredentialAdapter ? detectedCredentialAdapter : (wallet.adapter || 'auto'),
    origin: '',
  };
}

function currentSettingsChannel() {
  return (state.overview?.channels || []).find((channel) => channel.id === state.settingsChannelId) || null;
}

function settingsConfigDirty() {
  return Boolean(state.settingsDraft)
    && JSON.stringify(state.settingsDraft.config) !== state.settingsDraft.initialConfig;
}

function settingsWalletDirty() {
  return Boolean(state.settingsDraft)
    && JSON.stringify(state.settingsDraft.wallet) !== state.settingsDraft.initialWallet;
}

function hasWalletCredentialInput() {
  return Boolean($('#settings-wallet-credential')?.value);
}

function clearWalletCredentialInput() {
  const credential = $('#settings-wallet-credential');
  if (!credential?.value) return;
  credential.value = '';
  state.walletCredentialCleared = true;
}

function openChannelSettings(channel, tab = 'config', trigger = null, { billingOnly = false } = {}) {
  if (state.gatewayMode === 'gateway' && !billingOnly) { openGatewayChannel(channel.id, tab === 'wallet' ? 'billing' : 'basic', trigger); return; }
  if (state.settingsEditor) state.settingsEditor = closeEditorDraft(state.settingsEditor);
  state.settingsEditor = createEditorDraft(channel);
  const config = configDraft(channel);
  state.settingsEditor.testModel = config.testModel;
  const wallet = walletDraft(channel);
  state.settingsChannelId = channel.id;
  state.settingsTab = tab === 'wallet' ? 'wallet' : 'config';
  state.settingsDraft = {
    config,
    wallet,
    initialConfig: JSON.stringify(config),
    initialWallet: JSON.stringify(wallet),
  };
  state.settingsTrigger = trigger;
  state.settingsBillingOnly = billingOnly;
  elements.channelSettingsConfigTab.textContent = billingOnly ? '采购成本' : '配置';
  state.walletCredentialCleared = false;
  $('#channel-settings-title').textContent = channel.name;
  $('#channel-settings-subtitle').textContent = `${channel.type} · 渠道 #${channel.id}`;
  renderChannelSettingsPanel();
  elements.channelSettingsDialog.showModal();
}

function syncSettingsModelControls(textarea, select, count) {
  const models = parseModelList(textarea.value);
  const previous = state.settingsDraft.config.testModel;
  select.replaceChildren();
  for (const model of models) select.add(new Option(model, model));
  select.add(new Option('请选择检测模型', ''), 0);
  const next = models.includes(previous) ? previous : '';
  state.settingsDraft.config.testModel = next;
  select.value = next;
  count.textContent = `${models.length} 个`;
}

function renderSettingsConfig(channel) {
  elements.channelSettingsPanel.replaceChildren($('#channel-settings-config-template').content.cloneNode(true));
  const draft = state.settingsDraft.config;
  const form = $('#channel-settings-config-form');
  const models = $('#settings-models');
  const testModel = $('#settings-test-model');
  const modelCount = $('#settings-model-count');
  const fetchButton = $('#settings-fetch-models');
  const fetchStatus = $('#settings-fetch-models-status');
  models.value = draft.modelsText;
  $('#settings-weight').value = draft.weight;
  $('#settings-priority').value = draft.priority;
  $('#settings-multiplier').value = draft.multiplier;
  $('#settings-cost-sync').checked = draft.costSyncMode === 'auto';
  syncSettingsModelControls(models, testModel, modelCount);
  const editorSession = state.settingsEditor.sessionId;
  const picker = mountModelPicker($('#settings-model-picker'), {
    getDraft: () => state.settingsEditor,
    setDraft: (next) => { state.settingsEditor = next; },
    onChange: (next) => {
      draft.modelsText = next.selected.join(', ');
      draft.testModel = next.testModel;
      models.value = draft.modelsText;
      syncSettingsModelControls(models, testModel, modelCount);
    },
  });

  models.addEventListener('input', () => {
    draft.modelsText = models.value;
    state.settingsEditor = setSelectedModels(state.settingsEditor, parseModelList(models.value));
    draft.testModel = state.settingsEditor.testModel;
    syncSettingsModelControls(models, testModel, modelCount);
    picker.render();
  });
  testModel.addEventListener('change', () => {
    draft.testModel = testModel.value;
    state.settingsEditor = { ...state.settingsEditor, testModel: testModel.value, testResult: null };
  });
  $('#settings-weight').addEventListener('input', (event) => { draft.weight = event.target.value; });
  $('#settings-priority').addEventListener('input', (event) => { draft.priority = event.target.value; });
  $('#settings-multiplier').addEventListener('input', (event) => { draft.multiplier = event.target.value; });
  $('#settings-cost-sync').addEventListener('change', (event) => {
    draft.costSyncMode = event.target.checked ? 'auto' : 'manual';
  });
  fetchButton.addEventListener('click', async () => {
    const started = beginDiscovery(state.settingsEditor);
    state.settingsEditor = started.draft;
    fetchButton.disabled = true;
    fetchStatus.textContent = '正在拉取';
    try {
      const result = await api(`/api/channels/${channel.id}/models`, { method: 'POST', body: '{}' });
      if (!state.settingsEditor || !isCurrentDiscovery(state.settingsEditor, started.token)) return;
      state.settingsEditor = finishDiscovery(state.settingsEditor, started.token, result);
      picker.render();
      fetchStatus.textContent = state.settingsEditor.discoveryError || `已发现 ${state.settingsEditor.discovered.length} 个，勾选后保存；已有选择保留`;
    } catch (error) {
      if (!state.settingsEditor || !isCurrentDiscovery(state.settingsEditor, started.token)) return;
      state.settingsEditor = finishDiscovery(state.settingsEditor, started.token, { error: error.message });
      fetchStatus.textContent = state.settingsEditor.discoveryError;
    } finally {
      if (state.settingsEditor?.sessionId === editorSession && state.settingsEditor.requestSerial === started.token?.serial && fetchButton.isConnected) fetchButton.disabled = false;
    }
  });
  form.addEventListener('submit', (event) => saveChannelSettings(event, channel));
  $('#cancel-channel-settings-config').addEventListener('click', requestCloseChannelSettings);
}

function renderSettingsCost(channel) {
  elements.channelSettingsPanel.replaceChildren($('#channel-settings-cost-template').content.cloneNode(true));
  const draft = state.settingsDraft.config;
  const rate = $('#settings-multiplier'), auto = $('#settings-cost-sync');
  rate.value = draft.multiplier; auto.checked = draft.costSyncMode === 'auto';
  const update = () => { rate.disabled = auto.checked; rate.required = !auto.checked; };
  rate.addEventListener('input', () => { draft.multiplier = rate.value; });
  auto.addEventListener('change', () => { draft.costSyncMode = auto.checked ? 'auto' : 'manual'; update(); });
  update();
  $('#channel-settings-cost-form').addEventListener('submit', (event) => saveCostSettings(event, channel));
  $('#cancel-channel-settings-cost').addEventListener('click', requestCloseChannelSettings);
}

function renderSettingsWallet(channel) {
  elements.channelSettingsPanel.replaceChildren($('#channel-settings-wallet-template').content.cloneNode(true));
  const wallet = channel.wallet || {};
  const draft = state.settingsDraft.wallet;
  const form = $('#channel-settings-wallet-form');
  const adapter = $('#settings-wallet-adapter');
  const origin = $('#settings-wallet-origin');
  const credential = $('#settings-wallet-credential');
  const clearedNote = $('#settings-credential-cleared-note');
  for (const [value, label] of Object.entries(walletAdapterNames)) adapter.add(new Option(label, value));
  adapter.value = draft.adapter;
  origin.value = draft.origin;
  $('#settings-wallet-balance').textContent = formatBalance(wallet);
  $('#settings-wallet-current-note').textContent = [
    walletAdapterNames[wallet.detectedAdapter || wallet.adapter],
    wallet.status === 'ok' ? formatTime(wallet.fetchedAt) : walletStatusDetail(wallet),
  ].filter(Boolean).join(' · ');
  clearedNote.hidden = !state.walletCredentialCleared;

  const updateWalletFields = () => {
    const needsCredential = ['newapi', 'sub2', 'rightcode'].includes(adapter.value);
    $('#settings-wallet-origin-label').hidden = !needsCredential;
    $('#settings-wallet-credential-label').hidden = !needsCredential;
    credential.placeholder = wallet.configured
      ? '凭据已保存，留空保持不变'
      : adapter.value === 'sub2'
        ? '粘贴 Sub2 refresh token 或 refresh_token Cookie 值'
        : adapter.value === 'newapi'
          ? '粘贴 New API 访问令牌（个人设置里生成）'
          : '粘贴 Right Code user_token';
    $('#settings-wallet-credential-hint').textContent = needsCredential
      ? '管理凭据仅用于读取余额，不会回显或发送到浏览器以外的页面。'
      : '当前识别方式不需要额外管理凭据。';
  };
  adapter.addEventListener('change', () => {
    draft.adapter = adapter.value;
    updateWalletFields();
  });
  origin.addEventListener('input', () => { draft.origin = origin.value; });
  updateWalletFields();
  form.addEventListener('submit', (event) => saveWalletSettings(event, channel));
  $('#restore-wallet-auto').addEventListener('click', () => clearWalletSettings(channel));
  $('#cancel-channel-settings-wallet').addEventListener('click', requestCloseChannelSettings);
}

function renderChannelSettingsPanel() {
  const channel = currentSettingsChannel();
  if (!channel || !state.settingsDraft) return;
  const configSelected = state.settingsTab === 'config';
  elements.channelSettingsConfigTab.setAttribute('aria-selected', String(configSelected));
  elements.channelSettingsWalletTab.setAttribute('aria-selected', String(!configSelected));
  elements.channelSettingsConfigTab.tabIndex = configSelected ? 0 : -1;
  elements.channelSettingsWalletTab.tabIndex = configSelected ? -1 : 0;
  if (configSelected && state.settingsBillingOnly) renderSettingsCost(channel);
  else if (configSelected) renderSettingsConfig(channel);
  else renderSettingsWallet(channel);
}

function switchChannelSettingsTab(tab) {
  if (!state.settingsDraft || state.settingsEditor?.saving || state.settingsTab === tab) return;
  if (state.settingsTab === 'wallet') clearWalletCredentialInput();
  if (state.settingsEditor?.pendingDiscovery) state.settingsEditor = { ...state.settingsEditor, pendingDiscovery: null, discoveryStatus: 'idle' };
  state.settingsTab = tab;
  renderChannelSettingsPanel();
}

function resolveSettingsConfirm(result) {
  if (!state.settingsConfirmResolve) return;
  const resolve = state.settingsConfirmResolve;
  state.settingsConfirmResolve = null;
  elements.channelSettingsConfirm.hidden = true;
  resolve(result);
}

function confirmSettings({ title, message, acceptLabel = '放弃修改', danger = true }) {
  if (state.settingsConfirmResolve) resolveSettingsConfirm(false);
  $('#settings-confirm-title').textContent = title;
  $('#settings-confirm-message').textContent = message;
  const accept = $('#settings-confirm-accept');
  accept.textContent = acceptLabel;
  accept.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
  elements.channelSettingsConfirm.hidden = false;
  return new Promise((resolve) => { state.settingsConfirmResolve = resolve; });
}

function closeChannelSettings() {
  clearWalletCredentialInput();
  if (state.settingsEditor) closeEditorDraft(state.settingsEditor);
  state.settingsEditor = null;
  elements.channelSettingsDialog.close();
  const trigger = state.settingsTrigger;
  state.settingsChannelId = null;
  state.settingsDraft = null;
  state.settingsTrigger = null;
  state.settingsTab = 'config';
  state.settingsBillingOnly = false;
  state.walletCredentialCleared = false;
  elements.channelSettingsPanel.replaceChildren();
  if (trigger?.isConnected) trigger.focus();
}

async function requestCloseChannelSettings() {
  if (!elements.channelSettingsDialog.open) return;
  if (state.settingsEditor?.saving) return;
  if (settingsConfigDirty() || settingsWalletDirty() || hasWalletCredentialInput()) {
    const confirmed = await confirmSettings({
      title: '放弃未保存的修改？',
      message: '关闭后，本次模型、路由、成本或余额草稿将不会保留。',
    });
    if (!confirmed) return;
  }
  closeChannelSettings();
}

function channelActions(channel) {
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'text-button';
  edit.textContent = '设置';
  edit.addEventListener('click', (event) => openChannelSettings(channel, 'config', event.currentTarget));
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = `text-button ${channel.enabled ? 'danger' : ''}`;
  toggle.textContent = channel.enabled ? '停用' : '启用';
  toggle.addEventListener('click', () => setChannelStatus(channel, toggle));
  actions.append(edit, toggle);
  if (state.gatewayMode === 'gateway') {
    const more = document.createElement('details');
    more.className = 'channel-more';
    const summary = document.createElement('summary');
    summary.textContent = '···';
    summary.title = '更多操作';
    summary.setAttribute('aria-label', `${channel.name} 更多操作`);
    const menu = document.createElement('div');
    menu.className = 'channel-more-menu';
    for (const role of channel.poolRoles || []) {
      const health = channel.runtimeHealthByPool?.find((item) => item.poolId === role.poolId);
      const pending = state.gatewayHealthPending.has(JSON.stringify([channel.id, role.poolId]));
      const probe = document.createElement('button'); probe.type = 'button'; probe.className = 'text-button';
      probe.textContent = `检测 ${role.routingPool}`;
      // A re-render while a probe is running (periodic refresh) must keep the busy state, not offer a second click.
      if (state.gatewayProbing.has(JSON.stringify([channel.id, role.poolId]))) { probe.disabled = true; probe.textContent = '检测中…'; }
      probe.addEventListener('click', () => { more.open = false; probeGatewayChannel(channel, role.poolId, probe); });
      menu.append(probe);
      if (!['exhausted', 'auth_invalid'].includes(health?.state) && !pending) continue;
      const reason = document.createElement('span'); reason.className = 'muted';
      reason.textContent = `${role.routingPool} · ${pending ? '恢复结果待核对'
        : `${health?.state === 'auth_invalid' ? '凭据失效' : '余额耗尽'} · 暂停选路${state.gatewayHealthStale ? ' · 状态待同步' : ''}`}`;
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'text-button';
      reset.textContent = `${pending ? '核对恢复' : '恢复选路'} ${role.routingPool}`;
      reset.disabled = state.gatewayHealthStale && !pending;
      reset.addEventListener('click', () => resetGatewayHealth(channel, reset, role.poolId)); actions.append(reason, reset);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'text-button danger'; remove.textContent = '删除渠道';
    remove.addEventListener('click', () => { more.open = false; gatewayChannelAction('delete', channel, remove); });
    menu.append(remove);
    more.append(summary, menu);
    actions.append(more);
  }
  return actions;
}

const channelGroupOrder = ['Claude', 'OpenAI', 'Gemini', 'xAI', 'DeepSeek', 'Moonshot', 'Zhipu'];
const groupOrderIndex = (name) => channelGroupOrder.findIndex((item) => item.toLowerCase() === String(name).toLowerCase());

function groupChannelsByProvider(channels) {
  const groups = new Map();
  for (const channel of channels) {
    const pool = channel.routingPool || modelProviderOf(channel);
    if (!groups.has(pool)) groups.set(pool, []);
    groups.get(pool).push(channel);
  }
  for (const group of groups.values()) {
    group.sort((left, right) => (left.position !== undefined && right.position !== undefined ? left.position - right.position : 0)
      || Number(right.enabled) - Number(left.enabled)
      || right.priority - left.priority
      || compareChannelIds(left.id, right.id));
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === '其他' && right === '其他') return 0;
      if (left === '其他') return 1;
      if (right === '其他') return -1;
      const leftIndex = groupOrderIndex(left);
      const rightIndex = groupOrderIndex(right);
      if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    })
    .map(([pool, groupChannels]) => ({ pool, channels: groupChannels }));
}

function channelGroupRow(pool, channels) {
  const row = document.createElement('tr');
  row.className = 'channel-group-row';
  row.dataset.pool = pool;
  const td = document.createElement('td');
  td.colSpan = 8;
  const strong = document.createElement('strong');
  strong.textContent = pool;
  const span = document.createElement('span');
  const enabledCount = channels.filter((channel) => channel.enabled).length;
  span.textContent = `${channels.length} 个渠道 · ${enabledCount} 启用`;
  td.append(strong, span);
  row.append(td);
  return row;
}

function renderChannels() {
  state.gatewaySession?.refreshBilling();
  const channels = state.gatewayMode === 'gateway' ? gatewayChannels() : state.overview?.channels || [];
  elements.channelBody.replaceChildren();
  for (const { pool, channels: groupChannels } of groupChannelsByProvider(channels)) {
    elements.channelBody.append(channelGroupRow(pool, groupChannels));
    for (const channel of groupChannels) {
      const row = document.createElement('tr');
      row.className = 'channel-row';
      applyChannelColor(row, channel.id, providerFamilyOf(channel));
      row.append(
        cell(channelIdentity(channel), 'channel-main'),
        cell(modelPills(channel.models), 'channel-models'),
        cell(routeMetrics(channel), 'channel-route'),
        cell(costSummary(channel), 'channel-cost'),
        cell(channelModelPrice(channel), 'channel-price'),
        cell(walletSummary(channel), 'channel-wallet'),
        cell(channelQuality(channel), 'channel-quality'),
        cell(channelActions(channel), 'channel-actions'),
      );
      elements.channelBody.append(row);
    }
  }
  elements.channelEmpty.hidden = channels.length > 0;
  const autoCount = channels.filter((item) => item.costSync?.mode === 'auto').length;
  const walletCount = channels.filter((item) => item.wallet?.status === 'ok').length;
  const errorCount = channels.reduce((sum, item) => sum + (item.errorCount || 0), 0);
  const affectedChannels = channels.filter((item) => item.errorCount > 0).length;
  const settings = currentChannelHealthSettings();
  elements.channelHealthSettingsButton.disabled = false;
  elements.channelHealthSettingsButton.title = '';
  $('#channel-summary').textContent = `${channels.filter((item) => item.enabled).length}/${channels.length} 启用 · 每 ${settings.probeIntervalMinutes} 分钟探活 · ${errorCount} 次上游错误 / ${affectedChannels} 个渠道 · ${walletCount} 个余额已同步 · ${autoCount} 个自动同步成本`;
}

function renderModels() {
  const byChannel = state.costDistributionMode === 'channel';
  const items = (byChannel
    ? [...(state.overview?.channels || []), ...(state.overview?.removedChannels || [])]
        .filter((channel) => channel.requests > 0 || channel.estimatedCost > 0)
        .map((channel) => ({
          channelId: channel.id,
          providerFamily: providerFamilyOf(channel),
          name: channel.name,
          requests: channel.requests,
          tokens: channel.tokens,
          estimatedCost: channel.estimatedCost,
          estimatedCostIsLowerBound: channel.estimatedCostIsLowerBound,
        }))
    : (state.overview?.modelTests || []).map((item) => ({
        ...item,
        name: `${item.channelName} · ${item.model}`,
      })))
    .sort((left, right) => right.estimatedCost - left.estimatedCost || right.requests - left.requests || left.name.localeCompare(right.name));
  elements.modelList.replaceChildren();
  const totalCost = items.reduce((sum, item) => sum + (item.estimatedCost || 0), 0);
  const otherName = byChannel ? '其他渠道' : '其他模型测试';
  const rows = items.length > 5
    ? [
        ...items.slice(0, 5),
        items.slice(5).reduce((other, item) => ({
          name: otherName,
          requests: other.requests + item.requests,
          tokens: other.tokens == null && item.tokens == null ? null : (other.tokens ?? 0) + (item.tokens ?? 0),
          estimatedCost: other.estimatedCost + (item.estimatedCost || 0),
          estimatedCostIsLowerBound: other.estimatedCostIsLowerBound || item.estimatedCostIsLowerBound,
        }), { name: otherName, requests: 0, tokens: null, estimatedCost: 0, estimatedCostIsLowerBound: false }),
      ]
    : items;
  // 成本未知（没有任何可确认的正成本且存在未定价请求）时不显示 $0.00，条形回退为 Token/请求占比。
  const isUnpriced = (item) => !(item.estimatedCost > 0) && item.estimatedCostIsLowerBound === true;
  const allUnpriced = items.length > 0 && items.every(isUnpriced);
  const useTokens = allUnpriced && rows.some((item) => item.tokens > 0);
  const shareOf = (item) => (allUnpriced ? (useTokens ? item.tokens : item.requests) || 0 : item.estimatedCost || 0);
  const maxCost = Math.max(0.000000001, ...rows.map(shareOf));
  const totalIsLowerBound = items.some((item) => item.estimatedCostIsLowerBound);
  const title = byChannel ? '渠道成本分布' : '模型测试成本';
  $('#cost-distribution-title').textContent = title;
  elements.modelList.setAttribute('aria-label', title);
  elements.modelTotal.textContent = allUnpriced ? '未定价' : formatCost(totalCost);
  elements.modelTotal.classList.toggle('is-unpriced', allUnpriced);
  elements.modelTotal.title = allUnpriced ? '本周期全部请求缺少价格或渠道倍率，成本未知' : totalIsLowerBound ? '存在部分或未定价请求，当前仅汇总可确认的成本' : '仅统计经墨台的请求，按价格与倍率预估；模型测试单独统计';
  let rowIndex = 0;
  for (const model of rows) {
    const row = document.createElement('div');
    const hasChannelIdentity = model.channelId !== undefined;
    row.className = `model-row${hasChannelIdentity ? ' channel-distribution-row' : ''}`;
    if (hasChannelIdentity) applyChannelColor(row, model.channelId, model.providerFamily);
    const name = document.createElement('strong');
    name.className = 'model-name';
    name.textContent = model.name;
    name.title = model.name;
    const track = document.createElement('i');
    track.className = 'model-track';
    track.style.setProperty('--model-share', `${Math.max(2, shareOf(model) / maxCost * 100)}%`);
    row.style.setProperty('--row-index', String(rowIndex));
    rowIndex += 1;
    const amount = document.createElement('span');
    amount.className = 'model-amount';
    amount.textContent = isUnpriced(model) ? '未定价' : formatCost(model.estimatedCost);
    if (isUnpriced(model)) amount.classList.add('is-unpriced');
    const sourceText = model.priceSources?.length ? `；价格来源：${model.priceSources.join('、')}` : '';
    amount.title = model.estimatedCostIsLowerBound
      ? `存在部分或未定价请求，显示可确认的成本${sourceText}`
      : `仅统计经墨台的请求，按价格与倍率预估${sourceText}`;
    const meta = document.createElement('span');
    meta.className = 'model-meta';
    meta.textContent = `${decimal.format(model.requests)} 次 · ${formatTokens(model.tokens)} Token`;
    const values = document.createElement('span');
    values.className = 'model-values';
    values.append(amount, meta);
    row.append(name, track, values);
    elements.modelList.append(row);
  }
  if (allUnpriced) {
    const note = document.createElement('p');
    note.className = 'model-note';
    note.textContent = `成本未知：全部为未定价请求，条形按${useTokens ? ' Token ' : '请求数'}占比显示`;
    elements.modelList.append(note);
  }
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    empty.textContent = byChannel ? '暂无渠道成本数据' : '暂无模型测试成本数据';
    elements.modelList.append(empty);
  }
}

function cacheTrendSummary(points) {
  const summary = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheCreate', 'cacheKnownInput', 'cacheKnownRead', 'cacheKnownRequests', 'requests']) {
    const values = points.map((point) => point[key]).filter(Number.isFinite);
    summary[key] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  }
  const tokens = [summary.input, summary.output, summary.cacheRead, summary.cacheCreate].filter(Number.isFinite);
  summary.total = tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null;
  summary.cacheHitRate = summary.cacheKnownInput > 0 && summary.cacheKnownRead !== null
    ? summary.cacheKnownRead / summary.cacheKnownInput
    : null;
  return summary;
}

function formatCacheRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '';
}

function renderTrend() {
  const channels = state.overview?.channelTrends || [];
  if (state.trendChannelId && !channels.some((channel) => String(channel.channelId) === state.trendChannelId)) {
    state.trendChannelId = '';
  }
  elements.trendChannel.replaceChildren(new Option('全部渠道', ''));
  for (const channel of channels) elements.trendChannel.add(new Option(channel.channelName, String(channel.channelId)));
  elements.trendChannel.value = state.trendChannelId;
  const points = state.trendChannelId
    ? channels.find((channel) => String(channel.channelId) === state.trendChannelId)?.trend || []
    : state.overview?.trend || [];
  const summary = cacheTrendSummary(points);
  elements.trendSummary.replaceChildren();
  for (const [key, label, className] of [
    ['input', '输入', 'input'], ['output', '输出', 'output'],
    ['cacheRead', '缓存读取', 'read'], ['cacheCreate', '缓存写入', 'write'],
    ['total', 'Token 总量', 'total'], ['cacheHitRate', '缓存命中率', 'read'],
  ]) {
    const item = document.createElement('div');
    item.className = `trend-stat trend-stat-${className}`;
    const name = document.createElement('span');
    name.textContent = label;
    const value = document.createElement('strong');
    value.textContent = key === 'cacheHitRate' ? formatCacheRate(summary[key]) : formatTokens(summary[key]);
    const coverage = Number.isFinite(summary.cacheKnownRequests) && Number.isFinite(summary.requests)
      ? `；命中率覆盖 ${decimal.format(summary.cacheKnownRequests)} / ${decimal.format(summary.requests)} 个请求`
      : '';
    value.title = key === 'cacheHitRate'
      ? `已知缓存读取 Token / 对应请求的总输入 Token（输入 + 缓存读取 + 缓存写入）；缺失 usage 的请求不参与命中率${coverage}`
      : summary[key] === null ? '' : decimal.format(summary[key]);
    item.append(name, value);
    elements.trendSummary.append(item);
  }
  elements.trendChart.replaceChildren();
  state.trendPlot = [];
  const known = points.filter((point) => Number.isFinite(point.cacheHitRate));
  if (known.length === 0) {
    // 没有任何有命中率的时段才显示空态；只有 1 个时段时照常画点（不画线）。
    elements.trendChart.textContent = '暂无趋势数据';
    elements.trendChart.classList.add('empty-chart');
    return;
  }
  elements.trendChart.classList.remove('empty-chart');
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.classList.add('trend-svg');
  svg.setAttribute('viewBox', '0 0 1000 144');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '缓存命中率，纵轴 0% 至 100%，缺失 usage 的时段留空');
  // 面积渐变 + 从左向右的描绘遮罩（遮罩矩形用 transform: scaleX 动画）。
  const defs = document.createElementNS(namespace, 'defs');
  const gradient = document.createElementNS(namespace, 'linearGradient');
  gradient.setAttribute('id', 'trend-fill');
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '0');
  gradient.setAttribute('y2', '1');
  for (const [offset, className] of [['0', 'trend-stop-top'], ['1', 'trend-stop-bottom']]) {
    const stop = document.createElementNS(namespace, 'stop');
    stop.setAttribute('offset', offset);
    stop.classList.add(className);
    gradient.append(stop);
  }
  const clip = document.createElementNS(namespace, 'clipPath');
  clip.setAttribute('id', 'trend-clip');
  const reveal = document.createElementNS(namespace, 'rect');
  reveal.classList.add('trend-reveal');
  for (const [name, value] of [['x', '-6'], ['y', '-10'], ['width', '1012'], ['height', '170']]) reveal.setAttribute(name, value);
  clip.append(reveal);
  defs.append(gradient, clip);
  svg.append(defs);
  const yAxis = document.createElement('div');
  yAxis.className = 'trend-y-axis';
  for (const rate of [1, 0.5, 0]) {
    yAxis.append(Object.assign(document.createElement('span'), { textContent: `${rate * 100}%` }));
    const y = 142 - rate * 138;
    const line = document.createElementNS(namespace, 'line');
    line.classList.add('trend-grid');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '1000');
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    svg.append(line);
  }
  let segment = [];
  const startTime = Date.parse(points[0].time);
  const endTime = Date.parse(points.at(-1).time);
  const bucketMilliseconds = (state.overview.periodHours || state.hours) <= 48 ? 3_600_000 : 86_400_000;
  let previousTime = null;
  const appendSegment = () => {
    if (segment.length > 1) {
      const area = document.createElementNS(namespace, 'path');
      area.classList.add('trend-area');
      area.setAttribute('d', `M${segment[0].split(',')[0]},142 L${segment.join(' L')} L${segment.at(-1).split(',')[0]},142 Z`);
      area.setAttribute('clip-path', 'url(#trend-clip)');
      svg.append(area);
      const polyline = document.createElementNS(namespace, 'polyline');
      polyline.classList.add('trend-line', 'trend-line-read');
      polyline.setAttribute('points', segment.join(' '));
      polyline.setAttribute('clip-path', 'url(#trend-clip)');
      svg.append(polyline);
    }
    segment = [];
  };
  for (const point of points) {
    const timestamp = Date.parse(point.time);
    if (previousTime !== null && timestamp - previousTime > bucketMilliseconds) appendSegment();
    previousTime = timestamp;
    if (!Number.isFinite(point.cacheHitRate)) {
      appendSegment();
      continue;
    }
    const x = endTime > startTime ? (timestamp - startTime) / (endTime - startTime) * 1000 : 500;
    const y = 142 - Math.min(1, Math.max(0, point.cacheHitRate)) * 138;
    segment.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    const dot = document.createElementNS(namespace, 'circle');
    dot.classList.add('trend-dot');
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
    dot.setAttribute('r', '2.5');
    const title = document.createElementNS(namespace, 'title');
    title.textContent = `${formatTime(point.time, true)} · ${formatCacheRate(point.cacheHitRate)}`;
    dot.append(title);
    svg.append(dot);
    state.trendPlot.push({ xRatio: x / 1000, yRatio: y / 144, label: title.textContent, rate: formatCacheRate(point.cacheHitRate) });
  }
  appendSegment();
  const axis = document.createElement('div');
  axis.className = 'trend-axis';
  axis.append(
    Object.assign(document.createElement('span'), { textContent: formatTime(points[0].time, true) }),
    Object.assign(document.createElement('span'), { textContent: formatTime(points.at(-1).time, true) }),
  );
  elements.trendChart.append(yAxis, svg, axis);
  // 叠加层：稀疏数据（≤8 点）直接标数值；悬停十字准线与提示由 trendPointer 驱动。
  const overlay = document.createElement('div');
  overlay.className = 'trend-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  if (state.trendPlot.length <= 8) {
    for (const plotted of state.trendPlot) {
      const tag = document.createElement('span');
      tag.className = 'trend-value-label';
      tag.textContent = plotted.rate;
      tag.style?.setProperty('--tx', `${(plotted.xRatio * 100).toFixed(2)}%`);
      tag.style?.setProperty('--ty', `${(plotted.yRatio * 100).toFixed(2)}%`);
      overlay.append(tag);
    }
  }
  const cursor = document.createElement('i');
  cursor.className = 'trend-cursor';
  const tip = document.createElement('b');
  tip.className = 'trend-tip';
  overlay.append(cursor, tip);
  elements.trendChart.append(overlay);
}

// 趋势图悬停：找最近的点，移动十字准线并显示数值（事件在初始化时一次性委托）。
function trendPointer(event) {
  const overlay = elements.trendChart.querySelector('.trend-overlay');
  const plot = state.trendPlot;
  if (!overlay || !plot?.length) return;
  const box = overlay.getBoundingClientRect();
  if (!box.width) return;
  const ratio = (event.clientX - box.left) / box.width;
  const nearest = plot.reduce((best, item) => (Math.abs(item.xRatio - ratio) < Math.abs(best.xRatio - ratio) ? item : best), plot[0]);
  overlay.style.setProperty('--cx', `${(nearest.xRatio * 100).toFixed(2)}%`);
  overlay.style.setProperty('--cy', `${(nearest.yRatio * 100).toFixed(2)}%`);
  const tip = overlay.querySelector('.trend-tip');
  tip.textContent = nearest.label;
  // 提示框以点为中心，两端的点会伸出图表（右端伸出浏览器），按实际宽度平移回图表内。
  const half = tip.offsetWidth / 2, center = nearest.xRatio * box.width;
  const shift = Math.max(0, half - center) - Math.max(0, center + half - box.width);
  overlay.style.setProperty('--tip-shift', `${shift.toFixed(1)}px`);
  overlay.classList.add('is-active');
}

function trendPointerLeave() {
  elements.trendChart.querySelector('.trend-overlay')?.classList.remove('is-active');
}

function routeNode(log) {
  const wrapper = document.createElement('div');
  wrapper.className = `route-cell route-family-${log.providerFamily || 'unknown'}`;
  applyChannelColor(wrapper, log.channelId, log.providerFamily);
  const strong = document.createElement('strong');
  strong.textContent = log.channelName;
  const title = log.source === 'legacy' ? document.createElement('div') : null;
  if (title) {
    title.className = 'route-title';
    title.append(strong, Object.assign(document.createElement('span'), { className: 'legacy-badge', textContent: '旧 New API', title: '来自旧 New API 的历史请求' }));
  }
  const small = document.createElement('small');
  // 探活请求照 New API 标成"模型测试"，不显示内部调用方 internal-probe。
  const caller = log.isModelTest ? '模型测试' : callerName(log.tokenName);
  if (log.kind === 'error') {
    small.textContent = [isClientCancelled(log) ? '客户端断开' : `${log.statusCode ? `HTTP ${log.statusCode}` : '失败'} · 上游错误`, log.isModelTest ? caller : ''].filter(Boolean).join(' · ');
    small.classList.add('request-error-label');
  } else {
    small.textContent = log.channelRoute.length > 1 ? log.channelRoute.join(' → ') : [log.stream ? '流式' : '非流式', caller].filter(Boolean).join(' · ');
    if (log.failover) small.classList.add('failover');
  }
  if (log.cooldownTriggered) {
    small.append(' · ', Object.assign(document.createElement('span'), { className: 'cooldown-tag', textContent: '触发冷却', title: COOLDOWN_HINT }));
  }
  wrapper.append(title || strong, small);
  return wrapper;
}

// 网关请求的 tokenName 是 caller ID；用已加载的网关配置映射成名称，映射不到才显示 ID。
function callerName(callerId) {
  // New API 没记录令牌名的旧行 tokenName 为空，返回空串，调用处不再拼 "· null"。
  if (callerId === null || callerId === undefined || callerId === '') return '';
  const caller = (state.gatewayConfig?.callers || []).find((item) => item.id === callerId);
  return caller?.name || callerId;
}

// 未定价的成功请求显示可见的标签，原有 title 说明保留在单元格上。
function costNode(log) {
  if (log.kind !== 'success') return '';
  const unpriced = log.costStatus === 'unknown' || log.estimatedCost === null || log.estimatedCost === undefined;
  if (!unpriced) return `${log.costIsEstimate ? '约 ' : ''}${formatCost(log.estimatedCost)}`;
  const tag = document.createElement('span');
  tag.className = 'unpriced-tag';
  tag.textContent = '未定价';
  return tag;
}

// 首字和总耗时的三档颜色阈值。出处：New API rc25 usage-logs/lib/format.ts（用户选定照搬），集中放在这里，改规则只改这一处。
const latencyThresholds = Object.freeze({
  ttftOkSeconds: 5, ttftSlowSeconds: 10,
  durationOkSeconds: 10, durationSlowSeconds: 30,
  shortOutputTokens: 100,
  speedOkTokensPerSecond: 30, speedSlowTokensPerSecond: 15,
});

// 首字：< 5 秒正常，< 10 秒延迟，其余超时；缺失或 ≤ 0 不分档（返回 null，显示 N/A）。
function ttftTier(ttftMs) {
  if (!Number.isFinite(ttftMs) || ttftMs <= 0) return null;
  const seconds = ttftMs / 1000;
  return seconds < latencyThresholds.ttftOkSeconds ? 'ok' : seconds < latencyThresholds.ttftSlowSeconds ? 'slow' : 'timeout';
}

// 总耗时：输出 token < 100 或耗时 ≤ 0 按时间判断（< 10 秒 / < 30 秒），其余按输出速度判断（≥ 30 / ≥ 15 tok/s）。耗时缺失不分档。
function durationTier(durationMs, outputTokens) {
  if (!Number.isFinite(durationMs)) return null;
  const seconds = durationMs / 1000;
  const short = !Number.isFinite(outputTokens) || outputTokens < latencyThresholds.shortOutputTokens || durationMs <= 0;
  if (short) return seconds < latencyThresholds.durationOkSeconds ? 'ok' : seconds < latencyThresholds.durationSlowSeconds ? 'slow' : 'timeout';
  const speed = outputTokens / seconds;
  return speed >= latencyThresholds.speedOkTokensPerSecond ? 'ok' : speed >= latencyThresholds.speedSlowTokensPerSecond ? 'slow' : 'timeout';
}

// 失败行不上色（本来也不显示耗时）。
function latencyTiers(log) {
  if (log.kind === 'error') return { ttft: null, duration: null };
  return { ttft: ttftTier(log.ttftMs), duration: durationTier(log.durationMs, log.outputTokens) };
}

function ttftValue(log) {
  if (log.kind === 'error') return { value: '', className: 'unavailable' };
  // 首字缺失（含非流式）或 ≤ 0：显示 N/A，不上色（New API 的做法）。
  if (!log.stream || !(log.ttftMs > 0)) return { value: 'N/A', className: 'unavailable' };
  const tier = latencyTiers(log).ttft;
  return { value: formatMs(log.ttftMs), className: tier ? `numeric latency-${tier}` : 'numeric' };
}

function tokenGrid(log) {
  if (log.kind === 'error') {
    const wrapper = document.createElement('div');
    wrapper.className = 'request-error-content';
    const status = document.createElement('strong');
    const cancelled = isClientCancelled(log);
    status.textContent = cancelled ? '客户端断开' : log.statusCode ? `HTTP ${log.statusCode}` : '上游错误';
    const message = document.createElement('span');
    message.textContent = cancelled ? '客户端在响应完成前断开了连接' : log.errorMessage || '请求失败';
    message.title = message.textContent;
    wrapper.append(status, message);
    return wrapper;
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'token-grid';
  const values = [
    ['输入', log.inputTokens, 'input'],
    ['输出', log.outputTokens, 'output'],
    ['缓存写', log.cacheCreateTokens, 'cache-write'],
    ['缓存读', log.cacheReadTokens, 'cache-read'],
  ];
  for (const [label, value, className] of values) {
    const item = document.createElement('span');
    item.className = `token-${className}`;
    const name = document.createElement('em');
    name.textContent = label;
    const amount = document.createElement('b');
    amount.textContent = formatTokens(value);
    if (log.cacheReadInferred && className === 'input') {
      amount.title = '上游没有返回缓存读取数，按全部未命中计';
    }
    item.append(name, amount);
    wrapper.append(item);
  }
  return wrapper;
}

function reasoningNode(log) {
  const value = typeof log.reasoningEffort === 'string' ? log.reasoningEffort.trim() : '';
  const badge = document.createElement('span');
  const normalized = value.toLowerCase().replace(/[\s_]+/g, '-');
  const level = reasoningLevels.has(normalized) ? normalized : 'other';
  badge.className = value ? `reasoning-badge reasoning-${level}` : 'reasoning-empty';
  badge.textContent = value || '';
  badge.title = value
    ? `上游请求记录的 reasoning_effort: ${value}`
    : '该请求日志没有 reasoning_effort，未推测默认值';
  return badge;
}

function latencyNode(log) {
  const wrapper = document.createElement('div');
  wrapper.className = 'latency-cell';
  const ttft = ttftValue(log);
  const first = document.createElement('span');
  first.append('首字 ', Object.assign(document.createElement('b'), { textContent: ttft.value, className: ttft.className }));
  const duration = document.createElement('span');
  const durationTone = latencyTiers(log).duration;
  duration.append('总耗时 ', Object.assign(document.createElement('b'), { textContent: formatMs(log.durationMs), className: durationTone ? `latency-${durationTone}` : '' }));
  const rate = document.createElement('span');
  rate.title = '全请求平均输出速率 = 输出 Token ÷ 总耗时（含等待，输出可能含推理 Token）；New API 耗时仅精确到秒，属于估算吞吐量';
  const knownRate = log.kind === 'success' && Number.isFinite(log.outputTokensPerSecond) && log.outputTokensPerSecond > 0;
  rate.append('输出 TPS ', Object.assign(document.createElement('b'), {
    textContent: knownRate ? `${log.outputTokensPerSecond.toFixed(1)} tok/s` : '',
    className: knownRate ? 'numeric' : 'unavailable',
  }));
  wrapper.append(first, duration, rate);
  return wrapper;
}

// 延迟瀑布：首字段 + 生成段，长度按当前页最大耗时缩放（只用 transform: scaleX 动画）。
function latencyWithWaterfall(log, maxDuration) {
  const wrapper = latencyNode(log);
  const duration = Number.isFinite(log.durationMs) ? log.durationMs : null;
  if (duration === null || duration <= 0) return wrapper;
  const ttft = log.stream && Number.isFinite(log.ttftMs) ? Math.min(log.ttftMs, duration) : 0;
  const bar = document.createElement('div');
  bar.className = 'latency-waterfall';
  bar.setAttribute('aria-hidden', 'true');
  bar.style.setProperty('--wf-total', `${Math.max(2, duration / maxDuration * 100).toFixed(1)}%`);
  bar.style.setProperty('--wf-ttft', `${(ttft / maxDuration * 100).toFixed(1)}%`);
  bar.append(Object.assign(document.createElement('i'), { className: 'wf-ttft' }), Object.assign(document.createElement('i'), { className: 'wf-gen' }));
  wrapper.append(bar);
  return wrapper;
}

function renderRequests() {
  const data = state.requestPageData;
  const logs = data?.items || [];
  elements.requestBody.replaceChildren();
  const maxDuration = Math.max(1, ...logs.map((log) => (Number.isFinite(log.durationMs) ? log.durationMs : 0)));
  for (const log of logs) {
    const row = document.createElement('tr');
    const family = (log.model && providerLabelFamily[modelProviderOf({ models: [log.model] })]) || log.providerFamily || 'unknown';
    row.className = `${log.kind === 'error' ? 'request-error-row' : 'request-success-row'} request-family-${family}`;
    applyChannelColor(row, log.channelId, log.providerFamily);
    const cost = cell(costNode(log), 'estimate request-cost');
    if (log.kind === 'success') {
      const source = log.priceSource ? `；价格来源：${log.priceSource}` : '';
      cost.title = log.costStatus === 'partial'
        ? `部分 Token 类别缺少价格或 usage，当前显示可确认的成本${source}`
        : log.costStatus === 'unknown'
          ? log.costStatusReason === 'model_not_priced'
            ? '未定价：官方价格表与 models.dev 同步价格均未找到该精确模型 ID'
            : log.costStatusReason === 'unsupported_context_tier'
              ? '未定价：该请求超过当前价格记录支持的上下文档位'
              : '未定价：当前请求缺少可用的价格或渠道倍率'
          : `完整价格重算${source}`;
    }
    row.append(
      cell(requestDetailButton(log), 'time-cell request-time'),
      cell(routeNode(log), 'request-route'),
      cell(log.model, 'model-cell request-model'),
      cell(reasoningNode(log), 'request-reasoning'),
      cell(tokenGrid(log), 'request-tokens'),
      cost,
      cell(latencyWithWaterfall(log, maxDuration), 'request-latency'),
    );
    if (log.kind === 'error') row.querySelector('.request-time')?.prepend(Object.assign(document.createElement('i'), { className: 'pulse-dot', title: '失败请求' }));
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, a, select, input')) return;
      openRequestDetail(log, row.querySelector('.request-detail-button'));
    });
    elements.requestBody.append(row);
  }
  const total = data?.total || 0;
  if (data?.mode === 'gateway') {
    const page = data.page || 1;
    elements.requestEmpty.hidden = logs.length > 0;
    elements.requestPagination.hidden = logs.length === 0 && page === 1;
    // 末页定位返回同一快照的精确总数，否则沿用第一页的筛选合计；都没有时只显示本页范围。
    const exactTotal = Number.isSafeInteger(data.total) ? data.total
      : !state.requestSummaryLoading && Number.isSafeInteger(state.requestSummary?.requests) ? state.requestSummary.requests : null;
    const size = data.pageSize || requestPageSize;
    const range = `${(page - 1) * size + 1}-${(page - 1) * size + logs.length}`;
    elements.requestPageSummary.textContent = !logs.length ? '本页暂无记录'
      : exactTotal === null ? `${range} 条` : `${range} / ${decimal.format(exactTotal)} 条`;
    elements.requestPageCurrent.textContent = exactTotal === null ? `第 ${page} 页`
      : `第 ${page} / 共 ${Math.max(page, Math.ceil(exactTotal / size))} 页`;
    elements.requestPagePrev.disabled = page <= 1;
    elements.requestPageNext.disabled = !data.hasMore;
    elements.requestPageFirst.disabled = page <= 1;
    elements.requestPageLast.disabled = !data.hasMore;
    return;
  }
  const pageCount = data?.pageCount || 1;
  const page = data?.page || 1;
  elements.requestEmpty.hidden = total > 0;
  elements.requestPagination.hidden = total === 0;
  if (total > 0) {
    const start = (page - 1) * requestPageSize;
    const end = Math.min(start + requestPageSize, total);
    elements.requestPageSummary.textContent = `${start + 1}-${end} / ${total} 条`;
    elements.requestPageCurrent.textContent = `${page} / ${pageCount}`;
    elements.requestPagePrev.disabled = page === 1;
    elements.requestPageNext.disabled = page === pageCount;
    elements.requestPageFirst.disabled = page === 1;
    elements.requestPageLast.disabled = page === pageCount;
  }
}

function requestDetailButton(log) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'request-detail-button';
  const formatted = formatTime(log.createdAt);
  const parts = formatted.split(' ');
  if (parts.length === 2) {
    const clock = document.createElement('span');
    clock.className = 'time-clock';
    clock.textContent = parts[1];
    const date = document.createElement('span');
    date.className = 'time-date';
    date.textContent = parts[0];
    button.append(clock, date);
  } else {
    button.textContent = formatted;
  }
  button.setAttribute('aria-label', `查看请求详情：${formatted} ${log.model || ''}`.trim());
  button.addEventListener('click', () => openRequestDetail(log, button));
  return button;
}

// 只从列表已有字段里逐项显式取值，不读取、不展示请求或响应正文。
function requestDetailFields(log) {
  const unknown = '未知';
  const known = (value) => (value === null || value === undefined || value === '' ? unknown : String(value));
  const failed = log.kind === 'error';
  const tokens = (value) => (value === null || value === undefined ? unknown : decimal.format(value));
  const rate = !failed && Number.isFinite(log.outputTokensPerSecond) && log.outputTokensPerSecond > 0
    ? `${log.outputTokensPerSecond.toFixed(1)} tok/s` : unknown;
  const costStatusLabels = { complete: '完整', partial: '部分', unknown: '未定价' };
  return [
    ['时间', formatTime(log.createdAt) || unknown],
    ['结果', isClientCancelled(log) ? '客户端断开' : failed ? `失败${log.statusCode ? ` · HTTP ${log.statusCode}` : ''}` : '成功'],
    ['渠道', known(log.channelName)],
    ['路径', Array.isArray(log.channelRoute) && log.channelRoute.length > 1 ? log.channelRoute.join(' → ') : known(log.channelName)],
    ['API 密钥', log.isModelTest ? '模型测试' : known(log.tokenName)],
    ['模型', known(log.model)],
    ['推理强度', known(log.reasoningEffort)],
    ['传输', failed ? unknown : (log.stream ? '流式' : '非流式')],
    ['自动切换', log.failover ? '是（同一请求换渠道）' : log.cooldownTriggered ? '触发冷却（之后 60 秒新请求走备用渠道）' : '否'],
    ['输入 Token', failed ? unknown : tokens(log.inputTokens)],
    ['输出 Token', failed ? unknown : tokens(log.outputTokens)],
    ['缓存读取 Token', failed ? unknown : tokens(log.cacheReadTokens)],
    ['缓存写入 Token', failed ? unknown : tokens(log.cacheCreateTokens)],
    [log.costIsEstimate ? '单笔预估成本' : '采购真实成本', failed ? unknown : known(formatCost(log.estimatedCost))],
    ['成本完整度', failed ? unknown : known(costStatusLabels[log.costStatus] || log.costStatus)],
    ['价格来源', known(log.priceSource)],
    ['首字延迟', log.stream ? known(formatMs(log.ttftMs)) : unknown, latencyTiers(log).ttft],
    ['总耗时', known(formatMs(log.durationMs)), latencyTiers(log).duration],
    ['输出 TPS', rate],
    ['错误摘要', isClientCancelled(log) ? '客户端断开' : failed ? known(log.errorMessage) : unknown],
  ];
}

function openRequestDetail(log, trigger = null) {
  const list = $('#request-detail-fields');
  list.replaceChildren();
  const isError = log.kind === 'error';
  const rawFields = requestDetailFields(log);
  // 失败请求把“错误摘要”与“总耗时”提到紧跟“结果”之后，免得被连续“未知”字段挤到视口底部。
  const ordered = isError
    ? [
        ...rawFields.filter(([label]) => ['时间', '结果', '错误摘要', '总耗时', '渠道', '路径', 'API 密钥', '模型'].includes(label)),
        ...rawFields.filter(([label]) => !['时间', '结果', '错误摘要', '总耗时', '渠道', '路径', 'API 密钥', '模型'].includes(label)),
      ]
    : rawFields;
  for (const [label, rawValue, tier] of ordered) {
    if (!isError && label === '错误摘要' && rawValue === '未知') continue;
    const value = label === 'API 密钥' && rawValue !== '未知' && rawValue !== '模型测试'
      ? callerName(rawValue)
      : rawValue;
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    if (tier) description.classList.add(`latency-${tier}`);
    if (value === '未知') description.classList.add('detail-unknown');
    if (label === '结果') {
      description.classList.add(value === '成功' ? 'detail-status-ok' : value === '客户端断开' ? 'detail-status-warn' : 'detail-status-error');
    } else if (label === '错误摘要' && isError && value !== '未知') {
      term.classList.add('detail-error-term');
      description.classList.add('detail-error-box');
    } else if ((label === '采购真实成本' || label === '单笔预估成本') && value !== '未知') {
      description.classList.add('detail-money');
    }
    list.append(term, description);
  }
  $('#request-detail-subtitle').textContent = `${log.channelName || '未知渠道'} · ${log.model || '未知模型'}`;
  state.requestDetailTrigger = trigger;
  if (!elements.requestDetailDialog.open) elements.requestDetailDialog.showModal();
}

function syncFilters() {
  const currentChannel = elements.channelFilter.value;
  const currentModel = elements.modelFilter.value;
  const currentPool = elements.poolFilter.value;
  elements.poolFilter.replaceChildren(new Option('全部分组', ''));
  for (const pool of state.gatewayConfig?.pools || []) elements.poolFilter.add(new Option(pool.name || pool.id, pool.id));
  elements.poolFilter.hidden = state.gatewayMode !== 'gateway';
  elements.poolFilter.value = currentPool;
  elements.channelFilter.replaceChildren(new Option('全部渠道', ''));
  elements.modelFilter.replaceChildren(new Option('全部模型', ''));
  for (const channel of state.overview?.channels || []) elements.channelFilter.add(new Option(channel.name, channel.id));
  const models = new Set([
    ...(state.overview?.models || []).map((model) => model.model),
    ...(state.overview?.requestModels || []),
  ].filter(Boolean));
  for (const model of [...models].sort()) elements.modelFilter.add(new Option(model, model));
  elements.channelFilter.value = currentChannel;
  elements.modelFilter.value = currentModel;
}

function renderMetrics() {
  const data = state.overview;
  const metrics = data.metrics;
  const enabled = data.channels.filter((channel) => channel.enabled).length;
  $('#metric-channels').textContent = `${enabled}/${data.channels.length}`;
  // 可用渠道副行：按渠道所属池/厂商动态列出，不再写死三家。
  const vendorCounts = new Map();
  for (const channel of data.channels) {
    const label = channel.routingPool || channel.type || '其他';
    vendorCounts.set(label, (vendorCounts.get(label) || 0) + 1);
  }
  const vendorOrder = ['Claude', 'OpenAI', 'xAI', 'DeepSeek', 'Gemini', 'Moonshot', 'Zhipu'];
  const vendorRank = (label) => (vendorOrder.includes(label) ? vendorOrder.indexOf(label) : vendorOrder.length);
  $('#metric-channel-note').textContent = [...vendorCounts.entries()]
    .sort(([left], [right]) => vendorRank(left) - vendorRank(right) || left.localeCompare(right))
    .map(([label, count]) => `${count} ${label}`).join(' · ');
  $('#metric-requests').textContent = decimal.format(metrics.totalRequests);
  $('#metric-request-note').textContent = `成功 ${metrics.requests} · 失败 ${metrics.failedRequests} · 上游错误 ${metrics.errorCount}${metrics.cancelledRequests > 0 ? ` · 客户端断开 ${metrics.cancelledRequests}` : ''}`;
  $('#metric-request-note').classList.toggle('metric-error-note', metrics.errorCount > 0);
  $('#metric-tokens').textContent = formatTokens(metrics.totalTokens);
  $('#metric-token-note').textContent = `输入 ${formatTokens(metrics.inputTokens)} · 输出 ${formatTokens(metrics.outputTokens)}`;
  const coverage = metrics.costCoverage;
  const allUnpriced = coverage.complete === 0 && coverage.partial === 0 && coverage.unknown > 0;
  $('#metric-cost').textContent = allUnpriced ? '未定价' : formatCost(metrics.estimatedCost);
  $('#metric-cost').classList.toggle('is-unpriced', allUnpriced);
  $('#metric-cost').title = allUnpriced ? '本周期所有成功请求均缺少价格或渠道倍率，成本未知' : metrics.estimatedCostIsLowerBound ? '当前仅汇总可确认的成本，完整性见下方统计' : '仅统计经墨台的请求，按价格与倍率预估；不含直连上游的消费，模型测试单独统计';
  $('#metric-cost-note').textContent = `完整 ${coverage.complete} · 部分 ${coverage.partial} · 未定价 ${coverage.unknown}`;
  const pricing = data.modelPricing;
  const newApiPricing = data.newApiPricingSync;
  $('#metric-cost-note').title = pricing
    ? `models.dev：${pricing.lastSuccessAt ? `最近成功 ${formatTime(pricing.lastSuccessAt)}` : '尚未成功'}${pricing.lastError ? `；${pricing.lastError}` : ''}${newApiPricing ? `；New API 已同步 ${newApiPricing.counts?.synced || 0}，待确认 ${newApiPricing.counts?.pending || 0}` : ''}`
    : '';
  $('#metric-cache-read').textContent = data.availability.cacheRead ? formatTokens(metrics.cacheReadTokens) : '';
  $('#metric-cache-create').textContent = data.availability.cacheCreate ? formatTokens(metrics.cacheCreateTokens) : '';
  const cooldowns = metrics.cooldowns ?? 0;
  $('#metric-failover').textContent = decimal.format(cooldowns + metrics.failovers);
  $('#metric-failover-note').textContent = `冷却换渠道 ${decimal.format(cooldowns)} · 旧 New API 同请求换渠道 ${decimal.format(metrics.failovers)}`;
  $('#metric-latency').textContent = formatMs(metrics.avgDurationMs);
  if (metrics.ttftCount === 0) $('#metric-latency-note').textContent = '';
  else if (metrics.ttftCount < 3) $('#metric-latency-note').textContent = `首字样本 ${metrics.ttftCount} 条 · ${formatMs(metrics.avgTtftMs)}`;
  else $('#metric-latency-note').textContent = `平均首字 ${formatMs(metrics.avgTtftMs)} · n=${metrics.ttftCount}`;
}

function renderPricingSync() {
  const sync = state.overview?.newApiPricingSync;
  const catalog = state.overview?.pricingCatalog || [];
  const priced = catalog.filter((row) => row.rates);
  elements.pricingSummary.textContent = `已配置模型 ${catalog.length} 个 · 已定价 ${priced.length} 个 · 未定价 ${catalog.length - priced.length} 个`
    + (sync?.lastError ? ` · 倍率同步：${sync.lastError}` : '');
  elements.pricingSyncBody.replaceChildren();
  for (const row of catalog) {
    const tr = document.createElement('tr');
    const rate = (key) => (row.rates?.[key] == null ? '—' : money.format(row.rates[key]));
    tr.append(
      cell(row.model),
      cell(row.family || '—'),
      cell(rate('input'), rate('input') === '—' ? 'is-none' : ''),
      cell(rate('output'), rate('output') === '—' ? 'is-none' : ''),
      cell(rate('cacheRead'), rate('cacheRead') === '—' ? 'is-none' : ''),
      cell(rate('cacheWrite'), rate('cacheWrite') === '—' ? 'is-none' : ''),
      cell(row.channels.join('、')),
      cell(row.rates ? (row.priceSource || 'models.dev') : '未定价'),
    );
    elements.pricingSyncBody.append(tr);
  }
  elements.pricingSyncEmpty.hidden = catalog.length > 0;
}

// 没有已知错误时任何一条都算更新（Date.parse('') 是 NaN，直接比较永远为假）。
function newerError(candidate, current) {
  const at = Date.parse(candidate?.createdAt || '');
  const known = Date.parse(current?.createdAt || '');
  return Number.isFinite(at) && (!Number.isFinite(known) || at > known);
}

// 网关概览不带最近一条错误（投影不保留普通请求的错误详情）：取本周期第一页失败请求，用接口挑出的那条补上提示条第二行。
async function loadLatestError(periodKey) {
  try {
    const query = periodQuery(periodKey);
    query.set('status', 'error');
    query.set('limit', '20');
    const data = await api(`/api/requests?${query}`);
    if (state.periodKey !== periodKey || !state.overview || !data.latestError) return;
    if (newerError(data.latestError, state.overview.latestError)) {
      state.overview.latestError = data.latestError;
      renderUpstreamAlert();
    }
  } catch {}
}

function renderUpstreamAlert() {
  const data = state.overview;
  const metrics = data.metrics;
  const latest = data.latestError;
  elements.upstreamAlert.hidden = metrics.errorCount === 0;
  if (metrics.errorCount === 0) return;
  elements.upstreamAlertTitle.textContent = `${periodLabel(data)}内 ${metrics.errorCount} 次上游错误，影响 ${metrics.failedRequests - (metrics.cancelledRequests || 0)} 个最终失败请求`;
  const status = latest?.statusCode ? `HTTP ${latest.statusCode}` : '上游错误';
  elements.upstreamAlertDetail.textContent = latest
    ? `最近：${formatTime(latest.createdAt)} · ${latest.channelName} · ${latest.model} · ${status} · ${latest.errorMessage || ''}`
    : '';
}

function pageFromHash(hash) {
  const name = String(hash || '').replace(/^#/, '');
  return pageNames.includes(name) ? name : null;
}

function renderSettingsPage() {
  renderPricingSync();
  syncChannelHealthSettingsForm();
  syncCostSyncSettingsForm();
  const callersNote = $('#settings-callers-note');
  if (callersNote) callersNote.hidden = state.gatewayMode !== 'legacy';
}

function renderPage(name) {
  if (typeof syncPeriodContext === 'function') syncPeriodContext(name);
  if (!state.overview) return;
  state.pageDirty[name] = false;
  if (name === 'overview') {
    renderMetrics();
    renderUpstreamAlert();
    renderModels();
    renderTrend();
  } else if (name === 'channels') {
    renderChannels();
  } else if (name === 'requests') {
    syncFilters();
    renderUpstreamAlert();
    loadRequests();
  } else if (name === 'settings') {
    renderSettingsPage();
  }
  if (typeof afterRender === 'function') afterRender(name);
}

function showPage(name) {
  if (state.page === name) return;
  if (state.page) state.pageScroll[state.page] = window.scrollY;
  const revisit = state.pageVisited.has(name);
  for (const panel of document.querySelectorAll('[data-page-panel]')) {
    const active = panel.dataset.pagePanel === name;
    panel.hidden = !active;
    if (active) panel.dataset.enter = revisit ? 'revisit' : 'first';
  }
  for (const link of document.querySelectorAll('.page-nav [data-page]')) {
    if (link.dataset.page === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.body.dataset.page = name;
  state.page = name;
  state.pageVisited.add(name);
  renderPage(name);
  if (name === 'channels') void refreshGatewayHealth();
  window.scrollTo({ top: state.pageScroll[name] || 0, left: 0, behavior: 'instant' });
}

function routeFromHash() {
  const name = pageFromHash(window.location.hash);
  if (!name && window.location.hash) window.history.replaceState(null, '', '#overview');
  showPage(name || 'overview');
}

function render() {
  const data = state.overview;
  if (!data) return;
  if (data.probeSettings) state.channelHealthSettings = data.probeSettings;
  if (data.costSyncSettings) state.costSyncSettings = data.costSyncSettings;
  const legacy = data.source?.legacy;
  const legacyNote = legacy ? ` · 含旧 New API 历史 ${formatTime(legacy.mergedFrom)} ~ ${formatTime(legacy.mergedTo)}${legacy.complete ? '' : '（导入中）'}` : '';
  elements.detail.textContent = `${periodLabel(data)} · 更新于 ${formatTime(data.generatedAt)}${legacyNote}`;
  const contextTime = $('#period-context-time');
  if (contextTime) contextTime.textContent = `更新于 ${formatTime(data.generatedAt)}`;
  for (const name of pageNames) state.pageDirty[name] = true;
  state.renderedPeriodKey = state.periodKey;
  renderPage(state.page || 'overview');
}

async function refresh({ quiet = false, force = false } = {}) {
  if (state.loading) {
    state.pendingRefresh = { quiet, force: force || state.pendingRefresh?.force || false };
    return;
  }
  if (Date.now() < state.rateLimitedUntil) {
    if (!quiet) showToast('New API 后台日志仍在限流，请稍后再试', 'error');
    // 不会走到 finally，这里要自己撤掉切换周期的遮罩
    elements.overview.classList.remove('is-switching');
    elements.overview.removeAttribute('aria-busy');
    return;
  }
  state.loading = true;
  elements.refresh.disabled = true;
  if (!quiet) elements.connection.textContent = '同步中';
  const requestedPeriodKey = state.periodKey;
  try {
    const query = periodQuery(requestedPeriodKey);
    if (force) query.set('force', '1');
    const overview = await api(`/api/overview?${query}`);
    if (state.periodKey !== requestedPeriodKey) return;
    const unchanged = Boolean(
      state.overview
      && overview.generatedAt
      && overview.generatedAt === state.overview.generatedAt
      && state.renderedPeriodKey === requestedPeriodKey,
    );
    // 网关概览不带最近一条错误；同一周期刷新时沿用已补上的那条，免得提示条第二行每次刷新都闪空。
    if (!overview.latestError && state.renderedPeriodKey === requestedPeriodKey) overview.latestError = state.overview?.latestError ?? null;
    state.overview = overview;
    const stale = state.overview.cacheStatus === 'stale';
    state.rateLimitedUntil = stale ? Date.now() + 2 * 60_000 : 0;
    const servingGen = state.gatewayStatus?.servingGen;
    elements.connection.textContent = state.gatewayMode === 'gateway'
      ? `网关已连接${servingGen ? ` · gen ${servingGen}` : ''}${stale ? ' · 显示缓存' : ''}`
      : stale ? 'New API 限流 · 显示缓存' : 'New API 已连接';
    elements.connection.className = `connection-state ${stale ? 'limited' : 'online'}`;
    state.lastRefreshAt = Date.now();
    if (!unchanged) {
      render();
    }
    if (state.gatewayMode === 'gateway' && state.page === 'channels') void refreshGatewayHealth();
    if (state.gatewayMode === 'gateway' && overview.metrics?.errorCount > 0 && !overview.latestError) void loadLatestError(requestedPeriodKey);
  } catch (error) {
    if (state.periodKey !== requestedPeriodKey) return;
    const rateLimited = error.status === 429;
    if (rateLimited) state.rateLimitedUntil = Date.now() + 2 * 60_000;
    elements.connection.textContent = rateLimited ? 'New API 后台日志限流' : '连接失败';
    elements.connection.className = `connection-state ${rateLimited ? 'limited' : 'offline'}`;
    elements.detail.textContent = rateLimited ? '已暂停自动刷新 2 分钟' : error.message;
    if (!quiet) showToast(rateLimited ? 'New API 正在限制后台日志读取，已暂停自动刷新 2 分钟' : error.message, 'error');
  } finally {
    state.loading = false;
    elements.refresh.disabled = false;
    if (state.periodKey === requestedPeriodKey) {
      elements.overview.classList.remove('is-switching');
      elements.overview.removeAttribute('aria-busy');
    }
    if (state.pendingRefresh) {
      const pending = state.pendingRefresh;
      state.pendingRefresh = null;
      await refresh(pending);
    }
  }
}

async function loadRequests({ fresh = false, quiet = true, page = state.requestPage, last = false, preserveScroll = false } = {}) {
  if (Date.now() < state.requestRateLimitedUntil) {
    if (!quiet) showToast('最近请求读取仍在限流，请稍后再试', 'error');
    return;
  }
  const token = ++state.requestToken;
  const requestedPeriodKey = state.periodKey;
  const scrollY = preserveScroll ? window.scrollY : null;
  const paginationTop = preserveScroll ? elements.requestPagination.getBoundingClientRect().top : null;
  if (fresh) {
    state.requestLoading = true;
    elements.requestRefresh.disabled = true;
  }
  try {
    const query = periodQuery(requestedPeriodKey);
    query.set('page', String(page));
    const channel = elements.channelFilter.value;
    const model = elements.modelFilter.value;
    const status = elements.statusFilter.value;
    const stream = elements.streamFilter.value;
    const pool = state.gatewayMode === 'gateway' ? elements.poolFilter.value : '';
    if (pool) query.set('pool', pool);
    if (channel) query.set('channel', channel);
    if (model) query.set('model', model);
    if (status) query.set('status', status);
    if (stream) query.set('stream', stream);
    if (fresh) query.set('fresh', '1');
    if (state.gatewayMode === 'gateway') {
      const signature = JSON.stringify([requestedPeriodKey, channel, pool, model, status, stream]);
      if (fresh || signature !== state.requestCursorQuery) {
        const filtersChanged = signature !== state.requestCursorQuery;
        state.requestPage = 1;
        page = 1;
        last = false;
        state.requestCursors = [{}];
        state.requestCursorQuery = signature;
        // 筛选或周期变了：旧合计作废，显示“加载中”；只是手动刷新则保留旧值直到新值到达。
        if (filtersChanged) { state.requestSummary = null; state.requestSummaryLoading = true; renderRequestSummary(); }
      }
      const cursor = state.requestCursors[(last ? state.requestPage : page) - 1] || {};
      query.set('page', String(page));
      for (const key of ['cursor', 'reverse', 'snapshotSeq', 'from', 'to']) {
        if ((last || page === 1) && ['cursor', 'reverse'].includes(key)) continue;
        if (cursor[key]) query.set(key, cursor[key]);
      }
      if (last) query.set('last', '1');
    } else if (last) {
      query.set('page', String(state.requestPageData?.pageCount || 1));
    }
    const data = await api(`/api/requests?${query}`);
    if (token !== state.requestToken || state.periodKey !== requestedPeriodKey) return;
    state.requestPageData = data;
    state.requestPage = data.page;
    // summary 只出现在网关模式第一页；翻页响应没有这个字段，保留已有合计。旧 New API 模式整块隐藏。
    if (data.mode !== 'gateway') state.requestSummary = null;
    else if (data.summary) state.requestSummary = data.summary;
    else if (data.page === 1) state.requestSummary = null;
    state.requestSummaryLoading = false;
    renderRequestSummary();
    if (data.mode === 'gateway') {
      const index = data.page - 1;
      state.requestCursors[index] = { ...(query.has('cursor') && { cursor: query.get('cursor') }), ...(data.reverse && { reverse: '1' }), snapshotSeq: data.snapshotSeq,
        from: data.periodStartAt, to: data.periodEndAt };
      if (data.reverse && data.previousCursor && index > 0) state.requestCursors[index - 1] = {
        cursor: data.previousCursor, reverse: '1', snapshotSeq: data.snapshotSeq, from: data.periodStartAt, to: data.periodEndAt };
      else if (data.hasMore && data.nextCursor) state.requestCursors[index + 1] = {
        cursor: data.nextCursor, snapshotSeq: data.snapshotSeq, from: data.periodStartAt, to: data.periodEndAt };
      else if (!data.hasMore) state.requestCursors.length = index + 1;
    }
    state.requestRateLimitedUntil = 0;
    renderRequests();
    if (preserveScroll && window.scrollY === scrollY) window.scrollBy({
      top: elements.requestPagination.getBoundingClientRect().top - paginationTop, behavior: 'instant',
    });
    if (data.latestError && state.overview && newerError(data.latestError, state.overview.latestError)) {
      state.overview.latestError = data.latestError;
      renderUpstreamAlert();
    }
    if (fresh && !quiet && data.recentCacheStatus === 'stale') {
      showToast('New API 日志暂时限流，已显示最近一次读取结果', 'error');
    }
  } catch (error) {
    if (token !== state.requestToken || state.periodKey !== requestedPeriodKey) return;
    if (error.status === 429) state.requestRateLimitedUntil = Date.now() + 60_000;
    if (state.requestSummaryLoading) { state.requestSummaryLoading = false; renderRequestSummary(); }
    if (!quiet) showToast(error.status === 429 ? '最近请求读取过于频繁，请稍后再试' : error.message, 'error');
  } finally {
    if (fresh) {
      state.requestLoading = false;
      elements.requestRefresh.disabled = false;
    }
  }
}

async function saveChannelSettings(event, channel) {
  event.preventDefault();
  if (state.settingsEditor?.saving) return;
  const draft = state.settingsDraft?.config;
  if (!draft || state.settingsChannelId !== channel.id) return;
  const editorSession = state.settingsEditor.sessionId;
  const saveButton = $('#save-channel-settings-config');
  const cancelButton = $('#cancel-channel-settings-config');
  const status = $('#channel-settings-config-status');
  const weight = Number(draft.weight);
  const priority = Number(draft.priority);
  const multiplier = Number(draft.multiplier);
  const models = parseModelList(draft.modelsText);
  if (![weight, priority].every((value) => Number.isInteger(value) && value >= 0 && value <= 100000)) {
    status.textContent = '权重和优先级必须是 0 到 100000 的整数';
    return;
  }
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 100) {
    status.textContent = '成本倍率必须在 0 到 100 之间';
    return;
  }
  if (draft.costSyncMode === 'auto' && (multiplier < 0.001 || multiplier > 10)) {
    status.textContent = '自动同步的成本倍率必须在 0.001 到 10 之间';
    return;
  }
  if (!models.length) {
    status.textContent = '至少需要保留一个可用模型';
    return;
  }
  if (!models.includes(draft.testModel)) {
    status.textContent = '检测模型必须在可用模型列表中';
    return;
  }
  if (settingsWalletDirty()) {
    const confirmed = await confirmSettings({
      title: '只保存配置？',
      message: '上游余额页还有未保存的修改。继续后将保存配置并放弃余额草稿。',
      acceptLabel: '保存配置',
      danger: false,
    });
    if (!confirmed) return;
  }
  saveButton.disabled = true;
  state.settingsEditor = { ...state.settingsEditor, saving: true };
  cancelButton.disabled = true;
  status.textContent = '';
  try {
    await api(`/api/channels/${channel.id}/settings`, {
      method: 'PUT',
      body: JSON.stringify({
        weight,
        priority,
        models,
        testModel: draft.testModel,
        multiplier,
        costSyncMode: draft.costSyncMode,
        baseVersion: state.overview.costVersion,
      }),
    });
    if (state.settingsEditor?.sessionId === editorSession) closeChannelSettings();
    showToast(`${channel.name} 模型、路由与成本设置已更新`);
    await refresh({ quiet: true, force: true });
  } catch (error) {
    if (state.settingsEditor?.sessionId === editorSession) status.textContent = error.status === 409 ? '设置已变化，已刷新数据，请再次保存' : error.message;
    if (error.status === 409) await refresh({ quiet: true, force: true });
  } finally {
    if (state.settingsEditor?.sessionId === editorSession) state.settingsEditor = { ...state.settingsEditor, saving: false };
    if (saveButton.isConnected) saveButton.disabled = false;
    if (cancelButton.isConnected) cancelButton.disabled = false;
  }
}

// 请求进行中把按钮文字换成“保存中”，结束后恢复；按钮已被换掉（弹窗关闭）则不碰。
function withSavingLabel(button) {
  const idle = button.textContent;
  button.textContent = '保存中';
  return () => { if (button.isConnected) button.textContent = idle; };
}

async function saveCostSettings(event, channel) {
  event.preventDefault();
  if (!state.settingsBillingOnly || state.settingsEditor?.saving || state.settingsChannelId !== channel.id) return;
  const draft = state.settingsDraft.config;
  const status = $('#channel-settings-cost-status');
  const payload = { costSyncMode: draft.costSyncMode, baseVersion: state.overview.costVersion };
  if (draft.costSyncMode !== 'auto') {
    if (draft.multiplier.trim() === '' || !Number.isFinite(Number(draft.multiplier)) || Number(draft.multiplier) < 0 || Number(draft.multiplier) > 100) {
      status.textContent = '请填写 0 到 100 的手动成本倍率'; return;
    }
    payload.multiplier = Number(draft.multiplier);
  }
  if ((settingsWalletDirty() || hasWalletCredentialInput()) && !await confirmSettings({ title: '只保存成本设置？', message: '余额页有未保存的修改，继续会放弃余额草稿。', acceptLabel: '保存成本', danger: false })) return;
  const sessionId = state.settingsEditor.sessionId;
  const button = $('#save-channel-settings-cost');
  state.settingsEditor.saving = true; button.disabled = true; status.textContent = '';
  const restoreLabel = withSavingLabel(button);
  try {
    await api(`/api/channels/${encodeURIComponent(channel.id)}/cost`, { method: 'PUT', body: JSON.stringify(payload) });
    if (state.settingsEditor?.sessionId === sessionId) closeChannelSettings();
    showToast(`${channel.name} 成本设置已保存`);
    await refresh({ quiet: true, force: true });
    state.gatewaySession?.refreshBilling();
  } catch (error) {
    if (state.settingsEditor?.sessionId === sessionId) status.textContent = error.status === 409 ? '成本设置已变化，已刷新数据，请核对后再保存' : error.message;
    if (error.status === 409) await refresh({ quiet: true, force: true });
  } finally {
    if (state.settingsEditor?.sessionId === sessionId) state.settingsEditor.saving = false;
    restoreLabel();
    if (button.isConnected) button.disabled = false;
  }
}

async function saveWalletSettings(event, channel) {
  event.preventDefault();
  if (!state.settingsDraft || state.settingsEditor?.saving || state.settingsChannelId !== channel.id) return;
  const sessionId = state.settingsEditor.sessionId;
  const button = $('#save-channel-settings-wallet');
  const cancelButton = $('#cancel-channel-settings-wallet');
  const status = $('#channel-settings-wallet-status');
  const credentialInput = $('#settings-wallet-credential');
  const input = {
    adapter: state.settingsDraft.wallet.adapter,
    origin: state.settingsDraft.wallet.origin.trim(),
    credential: credentialInput.value,
  };
  if (settingsConfigDirty()) {
    const confirmed = await confirmSettings({
      title: '只保存余额设置？',
      message: '配置页还有未保存的修改。继续后将保存余额设置并放弃配置草稿。',
      acceptLabel: '保存余额设置',
      danger: false,
    });
    if (!confirmed) return;
  }
  button.disabled = true;
  state.settingsEditor.saving = true;
  cancelButton.disabled = true;
  status.textContent = '';
  const body = JSON.stringify(input);
  const restoreLabel = withSavingLabel(button);
  try {
    const result = await api(`/api/channels/${channel.id}/wallet`, { method: 'PUT', body });
    const wallet = result?.channels?.[String(channel.id)];
    // 凭据只在保存成功后才清空；失败时保留输入框内容，方便直接重试。
    credentialInput.value = '';
    state.walletCredentialCleared = Boolean(input.credential);
    closeChannelSettings();
    if (wallet?.status === 'error') {
      showToast(`${channel.name} 设置已保存，但${walletStatusDetail(wallet)}`, 'error');
    } else {
      showToast(`${channel.name} 余额设置已保存`);
    }
    await refresh({ quiet: true, force: true });
    state.gatewaySession?.refreshBilling();
  } catch (error) {
    status.textContent = error.message;
    const clearedNote = $('#settings-credential-cleared-note');
    if (clearedNote) clearedNote.hidden = !state.walletCredentialCleared;
  } finally {
    if (state.settingsEditor?.sessionId === sessionId) state.settingsEditor.saving = false;
    restoreLabel();
    if (button.isConnected) button.disabled = false;
    if (cancelButton.isConnected) cancelButton.disabled = false;
  }
}

async function clearWalletSettings(channel) {
  if (state.settingsEditor?.saving) return;
  const confirmed = await confirmSettings({
    title: '恢复自动识别？',
    message: settingsConfigDirty()
      ? '将删除该渠道的手动余额设置，并放弃配置页尚未保存的修改。'
      : '将删除该渠道的手动余额设置，并重新使用自动识别。',
    acceptLabel: '恢复自动',
  });
  if (!confirmed) return;
  if (state.settingsEditor?.saving || state.settingsChannelId !== channel.id) return;
  const sessionId = state.settingsEditor.sessionId;
  const button = $('#restore-wallet-auto');
  const status = $('#channel-settings-wallet-status');
  clearWalletCredentialInput();
  button.disabled = true;
  state.settingsEditor.saving = true;
  status.textContent = '';
  try {
    await api(`/api/channels/${channel.id}/wallet`, { method: 'DELETE', body: '{}' });
    closeChannelSettings();
    showToast(`${channel.name} 已恢复自动识别`);
    await refresh({ quiet: true, force: true });
    state.gatewaySession?.refreshBilling();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    if (state.settingsEditor?.sessionId === sessionId) state.settingsEditor.saving = false;
    if (button.isConnected) button.disabled = false;
  }
}

async function refreshWallet(channel, button) {
  button.disabled = true;
  try {
    const result = await api(`/api/channels/${channel.id}/wallet-refresh`, { method: 'POST', body: '{}' });
    const wallet = result?.channels?.[String(channel.id)];
    if (wallet?.status === 'error' || wallet?.status === 'needs_reauth') {
      showToast(`${channel.name}：${walletStatusDetail(wallet)}`, 'error');
    }
    await refresh({ quiet: true, force: true });
  } catch (error) {
    showToast(error.status === 429 ? '余额刷新过于频繁，请稍后再试' : error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function refreshCostMultiplier(channel, button) {
  button.disabled = true;
  try {
    const result = await api(`/api/channels/${channel.id}/cost-sync`, { method: 'POST', body: '{}' });
    const sync = result.pricing?.sync || {};
    if (sync.errorClass === 'probe_rate_limited') {
      showToast(`${channel.name} 一分钟内已探测过，当前倍率仍为 ${multiplier.format(result.pricing.multiplier)}×`);
    } else if (sync.status === 'synced') {
      showToast(`${channel.name} 成本倍率已刷新为 ${multiplier.format(result.pricing.multiplier)}×`);
    } else if (sync.status === 'unsupported') {
      showToast(`${channel.name}：${costSyncErrorName(sync.errorClass) || '上游不支持倍率同步'}`, 'error');
    } else {
      showToast(`${channel.name}：${costSyncErrorDetail(sync)}`, 'error');
    }
    await refresh({ quiet: true, force: true });
  } catch (error) {
    showToast(error.status === 409 ? '请先在编辑中开启自动同步' : error.message, 'error');
    await refresh({ quiet: true, force: true });
  } finally {
    button.disabled = false;
  }
}

async function refreshAllWallets() {
  const buttons = [elements.walletRefreshAll, elements.settingsWalletRefresh].filter(Boolean);
  for (const button of buttons) button.disabled = true;
  try {
    await api('/api/wallet-refresh', { method: 'POST', body: '{}' });
    await refresh({ quiet: true, force: true });
  } catch (error) {
    showToast(error.status === 429 ? '余额刷新过于频繁，请稍后再试' : error.message, 'error');
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

async function setChannelStatus(channel, button) {
  if (state.gatewayMode === 'gateway') { await gatewayChannelAction(channel.enabled ? 'disable' : 'enable', channel, button); return; }
  const nextStatus = channel.enabled ? 2 : 1;
  button.disabled = true;
  try {
    await api(`/api/channels/${channel.id}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
    showToast(`${channel.name} 已${nextStatus === 1 ? '启用' : '停用'}`);
    await refresh({ quiet: true, force: true });
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function setPrimaryChannel(channel, poolId) {
  if (state.gatewayMode === 'gateway') return setChannelPosition(channel, poolId, 1);
  if (state.routingChannelId !== null) return;
  if (channel.state === 'failing' && !await confirmUnhealthyPrimary(channel)) return;
  state.routingChannelId = channel.id;
  state.routingPool = channel.routingPool;
  renderChannels();
  try {
    const result = await api(`/api/channels/${channel.id}/primary`, { method: 'POST', body: '{}' });
    const affinitySuffix = result.affinityReset?.status === 'cleared'
      ? `，已刷新 ${result.affinityReset.deleted} 个会话绑定`
      : result.affinityReset?.status === 'failed'
        ? '，已有会话绑定刷新失败'
        : '';
    const groupSuffix = result.groupAdded ? `，已加入 ${result.groupAdded} 分组` : '';
    showToast(result.changed === false
      ? `${channel.name} 已是 ${result.poolLabel} 当前主用`
      : `${channel.name} 已设为 ${result.poolLabel} 主用${groupSuffix}${affinitySuffix}`,
    result.affinityReset?.status === 'failed' ? 'error' : 'normal');
    await refresh({ quiet: true, force: true });
  } catch (error) {
    showToast(error.status === 409 ? `${error.message}，请刷新后重试` : error.message, 'error');
    await refresh({ quiet: true, force: true });
  } finally {
    state.routingChannelId = null;
    state.routingPool = null;
    renderChannels();
  }
}

async function setChannelPosition(channel, poolId, position) {
  const role = channel.poolRoles?.find((item) => item.poolId === poolId) || channel;
  if (!channel.enabled || state.routingChannelId !== null || state.gatewayMutation || state.gatewayPendingOperation
    || !Number.isInteger(position) || position < 1 || position > role.poolSize || position === role.position) return;
  if (position === 1 && channel.state === 'failing' && !await confirmUnhealthyPrimary(channel)) return;
  state.routingChannelId = channel.id;
  state.routingPool = role.routingPool;
  renderChannels();
  try { await gatewayChannelAction(position === 1 ? 'primary' : 'reorder', channel, null, poolId, position); }
  finally { state.routingChannelId = null; state.routingPool = null; renderChannels(); }
}

function channelFormValue() {
  return {
    name: $('#channel-name').value.trim(),
    type: Number($('#channel-type').value),
    baseUrl: $('#channel-base-url').value.trim(),
    key: $('#channel-key').value.trim(),
    models: state.createEditor?.selected || parseModelList($('#channel-models').value),
    weight: Number($('#channel-weight').value),
    priority: Number($('#channel-priority').value),
    multiplier: Number($('#channel-multiplier').value),
    baseVersion: state.overview?.costVersion ?? 0,
  };
}

function gatewayChannels() {
  const config = state.gatewayConfig;
  if (!config) return [];
  return config.channels.map((channel) => {
    const observed = state.overview?.channels?.find((item) => String(item.id) === channel.id) || {};
    const poolIds = channel.poolIds || [channel.poolId];
    const runtimeHealthByPool = state.gatewayHealth?.gen === config.gen
      ? state.gatewayHealth.channels.filter((item) => item.channelId === channel.id && poolIds.includes(item.poolId)) : [];
    const runtimeHealth = runtimeHealthByPool.find((item) => item.poolId === channel.poolId) || null;
    const poolRoles = poolIds.map((poolId) => {
      const priority = channel.poolPriorities?.[poolId] ?? channel.priority;
      const peers = config.channels.filter((item) => (item.poolIds || [item.poolId]).includes(poolId))
        .sort((left, right) => (right.poolPriorities?.[poolId] ?? right.priority) - (left.poolPriorities?.[poolId] ?? left.priority)
          || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const position = peers.findIndex((item) => item.id === channel.id) + 1;
      return { poolId, routingPool: config.pools.find((pool) => pool.id === poolId)?.name || poolId, priority, position, poolSize: peers.length,
        routeRole: !channel.enabled ? 'disabled' : position === 1 ? 'primary' : 'fallback',
        isSolePrimary: channel.enabled && position === 1 };
    });
    const primary = poolRoles.find((role) => role.poolId === channel.poolId);
    return { ...observed, ...channel, poolIds, poolRoles, runtimeHealth, runtimeHealthByPool, models: channel.models.map((model) => model.modelId),
      routingPool: config.pools.find((pool) => pool.id === channel.poolId)?.name || channel.poolId,
      type: observed.type || channel.models[0]?.capabilities.join(' / ') || '', state: !channel.enabled ? 'disabled'
        : runtimeHealth && runtimeHealth.state !== 'available' ? runtimeHealth.state : (observed.state || 'unknown'),
      routeRole: primary?.routeRole, isSolePrimary: primary?.isSolePrimary,
      position: primary?.position, poolSize: primary?.poolSize,
      configWeightShare: null, costMultiplier: observed.costMultiplier ?? null, costSync: observed.costSync || {},
      wallet: observed.wallet || {}, modelPricing: observed.modelPricing || {} };
  });
}

async function refreshGatewayHealth() {
  if (state.gatewayMode !== 'gateway' || state.gatewayHealthLoading) return;
  state.gatewayHealthLoading = true;
  try {
    const result = await api('/api/gateway/channels/health');
    state.gatewayHealth = result.gen === state.gatewayConfig?.gen ? result : null;
    state.gatewayHealthStale = state.gatewayHealth === null;
  } catch { state.gatewayHealthStale = true; }
  finally { state.gatewayHealthLoading = false; renderChannels(); }
}

async function resetGatewayHealth(channel, button, poolId) {
  if (state.gatewayMutation || !state.gatewayConfig) return;
  if (!poolId || !(channel.poolIds || [channel.poolId]).includes(poolId)) return;
  const key = JSON.stringify([channel.id, poolId]);
  const health = channel.runtimeHealthByPool?.find((item) => item.poolId === poolId);
  const pending = state.gatewayHealthPending.get(key);
  if (!pending && (!health || state.gatewayHealthStale)) return;
  if (!pending && !window.confirm(`确认「${channel.name}」在 ${poolId} 分组的余额或凭据已处理？恢复后新请求可以重新选用；若上游仍异常，会再次暂停选路。`)) return;
  const payload = pending || { baseGen: state.gatewayConfig.gen, operationId: createEditorDraft().operationId,
    poolId, credentialVersion: health.credentialVersion, stateVersion: health.stateVersion };
  state.gatewayMutation = true; button.disabled = true;
  try {
    await api(`/api/gateway/channels/${encodeURIComponent(channel.id)}/health-reset`, { method: 'POST', body: JSON.stringify(payload) });
    state.gatewayHealthPending.delete(key);
    showToast('选路状态已恢复');
  } catch (error) {
    const uncertain = !error.status || error.status >= 500;
    if (uncertain) state.gatewayHealthPending.set(key, payload);
    else state.gatewayHealthPending.delete(key);
    showToast(uncertain ? '恢复结果待核对，请用同一按钮核对' : error.status === 409 ? '渠道状态已变化，请刷新后重新确认' : error.message, 'error');
  } finally {
    state.gatewayMutation = false;
    await refreshGatewayHealth();
    if (button.isConnected) button.disabled = false;
  }
}

function probeDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.max(1, Math.round(ms))} 毫秒`;
}

function probeFailureReason(result) {
  const names = { connect_failed: '连接上游失败', upstream_timeout: '上游响应超时', upstream_5xx: '上游服务错误', rate_limited: '上游限流',
    funds_exhausted: '上游余额不足', auth_invalid: '凭据被上游拒绝', invalid_request: '上游拒绝了请求', unsupported_model: '上游不支持该模型',
    permission_denied: '上游无权限', invalid_response: '上游响应无效', request_deadline: '检测超时', unknown_upstream: '上游返回未知错误' };
  const parts = [];
  if (result.statusCode) parts.push(`HTTP ${result.statusCode}`);
  if (result.errorClass) parts.push(names[result.errorClass] || result.errorClass);
  return parts.join(' · ') || '未收到上游响应';
}

// Manual probe, like New API's channel test: the button shows a busy state, the console waits for the real outcome
// (the core only answers "accepted"), and the toast says how long it took. The result is also in the channel's probe history.
async function probeGatewayChannel(channel, poolId, button) {
  if (!(channel.poolIds || [channel.poolId]).includes(poolId)) return;
  const key = JSON.stringify([channel.id, poolId]);
  if (state.gatewayProbing.has(key)) return;
  state.gatewayProbing.add(key);
  const idleLabel = button.textContent;
  button.disabled = true; button.textContent = '检测中…';
  const poolName = (channel.poolIds || []).length > 1 ? ` · ${channel.poolRoles?.find((role) => role.poolId === poolId)?.routingPool ?? poolId}` : '';
  const label = `${channel.name}${poolName}`;
  const release = () => {
    state.gatewayProbing.delete(key);
    if (button.isConnected) { button.disabled = false; button.textContent = idleLabel; }
  };
  try {
    const result = await api(`/api/channels/${encodeURIComponent(channel.id)}/test`,
      { method: 'POST', body: JSON.stringify({ poolId, wait: true }), signal: AbortSignal.timeout(75_000) });
    release();
    if (result.state === 'completed' && result.success) {
      showToast(`${label} 检测成功，耗时 ${probeDuration(result.latencyMs ?? result.waitedMs)} · ${result.model} · ${result.protocol}`, 'normal', 5000);
    } else if (result.state === 'completed') {
      showToast(`${label} 检测失败，${probeFailureReason(result)}，耗时 ${probeDuration(result.latencyMs ?? result.waitedMs)}`, 'error', 8000);
    } else if (result.waitTimedOut) {
      showToast(`${label} 检测超时，结果稍后会出现在探活记录里`, 'error', 8000);
    } else {
      showToast(`${label} 检测已提交，结果稍后会出现在探活记录里`);
    }
    await refresh({ quiet: true, force: true });
  } catch (error) {
    release();
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    showToast(timedOut ? `${label} 检测超时，结果稍后会出现在探活记录里` : `${label} 检测失败：${error.message}`, 'error', 8000);
  }
}

async function loadGatewayConfiguration() {
  const status = await api('/api/gateway/status');
  state.gatewayMode = status.mode;
  state.gatewayStatus = status;
  const brandNote = document.querySelector('.product small');
  if (brandNote) brandNote.textContent = status.mode === 'gateway' ? '墨台网关' : 'New API Ops · Local';
  if (status.mode === 'gateway') {
    state.gatewayConfig = (await api('/api/gateway/config')).config;
    if (!state.callerManager) {
      const root = document.createElement('section'); root.className = 'section-block data-section'; root.id = 'gateway-callers';
      $('#settings-callers-slot').append(root);
      state.callerManager = mountCallerManager({ root, getConfig: () => state.gatewayConfig, api, onSaved: gatewaySaved, notify: showToast,
        refreshConfig: async () => { state.gatewayConfig = (await api('/api/gateway/config')).config; } });
    }
    state.callerManager.render();
    renderGatewayConfigStatus();
  }
}

function renderGatewayConfigStatus() {
  const status = state.gatewayStatus;
  const pending = Boolean(status?.desiredGen && (status.desiredGen !== status.servingGen || status.desiredGen !== status.committedGen));
  $('#gateway-config-status').hidden = !pending;
  $('#gateway-config-status-text').textContent = !pending ? '' : status.discardAvailable
    ? '配置已被网关明确拒绝；可修复后重试，或放弃本次配置。'
    : status.activationErrorCode === 'desired_sync_failed' ? '配置目录同步失败，尚未请求生效；请重试核对。'
      : '配置已保存，等待生效；当前仍使用原配置。';
  $('#gateway-config-discard').hidden = !(pending && status.discardAvailable === true && status.desiredManifestSha256);
}

async function gatewaySaved(result) {
  if (result.config) state.gatewayConfig = result.config;
  else state.gatewayConfig = (await api('/api/gateway/config')).config;
  state.gatewayStatus = { ...state.gatewayStatus, ...result };
  delete state.gatewayStatus.oneTimeToken;
  state.callerManager?.render();
  renderChannels();
  renderGatewayConfigStatus();
  $('#gateway-config-reconcile').textContent = '重试生效';
  // 改名或新建的渠道，成本列和余额列来自 overview；不等 60 秒轮询，立刻刷新（失败由 refresh 自己处理）。
  void refresh({ quiet: true, force: true });
  return state.gatewayConfig;
}

function openGatewayChannel(channelId = null, tab = 'basic', trigger = $('#add-channel-button')) {
  if (!state.gatewayConfig) { showToast('网关配置尚未就绪', 'error'); return; }
  const channel = channelId === null ? null : state.gatewayConfig.channels.find((item) => item.id === channelId);
  if (channelId !== null && !channel) { showToast('渠道已变化，请刷新', 'error'); return; }
  if (state.gatewaySession && !state.gatewaySession.draft.closed) state.gatewaySession.close();
  state.gatewaySession = openGatewayEditor({ dialog: $('#gateway-channel-dialog'), template: $('#gateway-channel-template'),
    config: state.gatewayConfig, channel, api, onSaved: gatewaySaved, notify: showToast, trigger, tab,
    onSession: (session) => { state.gatewaySession = session; },
    mountBilling: (root, savedId) => mountGatewayBilling({ root, channelId: savedId,
      getChannel: (id) => {
        const saved = gatewayChannels().find((item) => item.id === id);
        return saved ? { ...saved, billingStale: !state.overview?.channels?.some((item) => String(item.id) === id)
          || state.overview.cacheStatus === 'stale' || state.overview.projection?.stale } : null;
      },
      renderCost: costSummary, renderPrice: channelModelPrice, renderWallet: walletSummary,
      openSettings: (id, settingsTab, settingsTrigger) => {
        const saved = gatewayChannels().find((item) => item.id === id);
        if (saved) openChannelSettings(saved, settingsTab, settingsTrigger, { billingOnly: true });
      } }) });
}

async function gatewayChannelAction(action, channel, button = null, poolId, position) {
  if (state.gatewayMutation || state.gatewayPendingOperation || !state.gatewayConfig) return;
  if (['primary', 'reorder'].includes(action) && (!channel.enabled || !poolId || !(channel.poolIds || [channel.poolId]).includes(poolId))) return;
  if (action === 'delete' && !window.confirm(`删除渠道「${channel.name}」？新请求将停止选用，历史日志与费用保留；调用者对该渠道的权限引用将移除。`)) return;
  state.gatewayMutation = true;
  if (button) button.disabled = true;
  const operationId = createEditorDraft().operationId;
  const payload = { baseGen: state.gatewayConfig.gen, operationId, change: { action, channelId: channel.id,
    ...(['primary', 'reorder'].includes(action) ? { poolId } : {}), ...(action === 'reorder' ? { position } : {}) } };
  try {
    const result = await api('/api/gateway/channels/change', { method: 'POST', body: JSON.stringify(payload) });
    state.gatewayPendingOperation = result.activated ? null : { state: 'pending', payload };
    await gatewaySaved(result);
    showToast(result.activated ? '渠道配置已生效' : '配置已保存，等待生效；仍在使用原配置', result.activated ? 'normal' : 'error');
  } catch (error) {
    if (!error.status) {
      state.gatewayPendingOperation = { state: 'unknown', payload };
      $('#gateway-config-status').hidden = false;
      $('#gateway-config-status-text').textContent = '操作结果尚待核对，重试会沿用同一操作。';
      $('#gateway-config-reconcile').textContent = '核对并重试同一操作';
      $('#gateway-config-discard').hidden = true;
    }
    showToast(error.status ? error.message : '操作结果尚待核对，请刷新网关状态后再操作', 'error');
  } finally {
    state.gatewayMutation = false;
    if (button?.isConnected) button.disabled = false;
  }
}

$('#gateway-config-reconcile').addEventListener('click', async () => {
  if (state.gatewayMutation) return;
  state.gatewayMutation = true;
  const button = $('#gateway-config-reconcile'); button.disabled = true;
  try {
    const pending = state.gatewayPendingOperation;
    const result = pending?.state === 'unknown' ? await api('/api/gateway/channels/change', { method: 'POST', body: JSON.stringify(pending.payload) })
      : await api('/api/gateway/reconcile', { method: 'POST' });
    state.gatewayPendingOperation = result.activated ? null : { state: 'pending', payload: pending?.payload };
    await gatewaySaved(result);
    showToast(result.activated ? '配置已生效' : '配置仍在等待生效', result.activated ? 'normal' : 'error');
  } catch (error) { showToast(error.message, 'error'); }
  finally { state.gatewayMutation = false; button.disabled = false; }
});

$('#gateway-config-discard').addEventListener('click', async () => {
  if (state.gatewayMutation || state.gatewayStatus?.discardAvailable !== true) return;
  if (!window.confirm('放弃这次被拒绝的配置并恢复原配置？本次签发或轮换的 API 密钥将作废；本次渠道启停/删除及密钥变更均撤销，旧状态保持；旧操作不会重新发布。')) return;
  state.gatewayMutation = true;
  const button = $('#gateway-config-discard'); button.disabled = true;
  try {
    const result = await api('/api/gateway/discard', { method: 'POST', body: JSON.stringify({
      gen: state.gatewayStatus.desiredGen, manifestSha256: state.gatewayStatus.desiredManifestSha256 }) });
    state.gatewayPendingOperation = null;
    if (state.gatewaySession && !state.gatewaySession.draft.closed) state.gatewaySession.close();
    $('#gateway-callers dialog[open]')?.close();
    await gatewaySaved(result);
    showToast(result.activated ? '已放弃本次配置，恢复原配置' : '恢复指针已写入，请重试核对目录同步', result.activated ? 'normal' : 'error');
  } catch (error) {
    showToast(error.message, 'error');
    await loadGatewayConfiguration().catch(() => {});
  } finally { state.gatewayMutation = false; button.disabled = false; }
});

function openChannelDialog() {
  if (state.gatewayMode === 'gateway') { openGatewayChannel(); return; }
  if (state.gatewayMode !== 'legacy') { showToast('正在核对网关配置模式，请稍后重试', 'error'); return; }
  $('#channel-form').reset();
  if (state.createEditor) closeEditorDraft(state.createEditor);
  state.createEditor = createEditorDraft();
  state.createModelPicker = mountModelPicker($('#channel-model-picker'), {
    getDraft: () => state.createEditor,
    setDraft: (next) => { state.createEditor = next; },
    onChange: (next) => { $('#channel-models').value = next.selected.join(', '); },
  });
  $('#channel-form-status').textContent = '';
  $('#fetch-models-button').disabled = false;
  $('#save-channel').disabled = false;
  $('#fetch-models-status').textContent = '拉取后仍需确认模型列表';
  elements.channelDialog.showModal();
}

async function fetchUpstreamModels() {
  const button = $('#fetch-models-button');
  const status = $('#fetch-models-status');
  const input = channelFormValue();
  const started = beginDiscovery(state.createEditor);
  if (!input.baseUrl || !input.key) {
    status.textContent = '请先填写上游地址和 API Key';
    return;
  }
  button.disabled = true;
  state.createEditor = started.draft;
  status.textContent = '正在拉取模型';
  try {
    const result = await api('/api/channels/fetch-models', {
      method: 'POST',
      body: JSON.stringify({ type: input.type, baseUrl: input.baseUrl, key: input.key }),
    });
    if (!state.createEditor || !isCurrentDiscovery(state.createEditor, started.token)) return;
    state.createEditor = finishDiscovery(state.createEditor, started.token, result);
    state.createModelPicker.render();
    status.textContent = state.createEditor.discoveryError || `已发现 ${state.createEditor.discovered.length} 个模型，请勾选；已有选择保留`;
  } catch (error) {
    if (!state.createEditor || !isCurrentDiscovery(state.createEditor, started.token)) return;
    state.createEditor = finishDiscovery(state.createEditor, started.token, { error: error.message });
    status.textContent = state.createEditor.discoveryError;
  } finally {
    if (state.createEditor?.sessionId === started.token?.sessionId && state.createEditor.requestSerial === started.token?.serial) button.disabled = false;
  }
}

async function createChannel(event) {
  event.preventDefault();
  if (!state.createEditor || state.createEditor.saving) return;
  const button = $('#save-channel');
  const status = $('#channel-form-status');
  const payload = channelFormValue();
  if (!payload.models.length) {
    status.textContent = '至少需要填写一个模型';
    return;
  }
  button.disabled = true;
  state.createEditor = { ...state.createEditor, saving: true };
  const editorSession = state.createEditor.sessionId;
  status.textContent = '';
  const body = JSON.stringify(payload);
  try {
    const result = await api('/api/channels', { method: 'POST', body });
    if (state.createEditor?.sessionId === editorSession) elements.channelDialog.close();
    showToast(result.pricingSaved ? '渠道已创建为停用，请检测后启用' : '渠道已创建，但成本倍率保存失败，请在渠道行补录', result.pricingSaved ? 'normal' : 'error');
    await refresh({ quiet: true, force: true });
  } catch (error) {
    if (state.createEditor?.sessionId === editorSession) status.textContent = error.message;
  } finally {
    if (state.createEditor?.sessionId === editorSession) state.createEditor = { ...state.createEditor, saving: false };
    if (!state.createEditor || state.createEditor.sessionId === editorSession) button.disabled = false;
  }
}

for (const button of document.querySelectorAll('[data-period]')) {
  button.addEventListener('click', () => {
    if (state.periodKey === button.dataset.period) return;
    state.periodKey = button.dataset.period;
    state.hours = periodDefinition(state.periodKey).hours;
    state.requestPageData = null;
    state.requestPage = 1;
    for (const item of document.querySelectorAll('[data-period]')) item.classList.toggle('active', item.dataset.period === state.periodKey);
    if (state.page === 'requests') window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    elements.overview.classList.add('is-switching');
    elements.overview.setAttribute('aria-busy', 'true');
    elements.detail.textContent = `正在读取${periodDefinition(state.periodKey).label}…`;
    refresh();
  });
}
for (const button of document.querySelectorAll('[data-cost-distribution]')) {
  button.addEventListener('click', () => {
    state.costDistributionMode = button.dataset.costDistribution;
    for (const item of document.querySelectorAll('[data-cost-distribution]')) {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', String(active));
    }
    renderModels();
  });
}
elements.trendChannel.addEventListener('change', () => {
  state.trendChannelId = elements.trendChannel.value;
  renderTrend();
});
elements.refresh.addEventListener('click', () => refresh({ force: true }));
elements.requestRefresh.addEventListener('click', () => loadRequests({ fresh: true, quiet: false }));
elements.walletRefreshAll.addEventListener('click', refreshAllWallets);
for (const filter of [elements.channelFilter, elements.poolFilter, elements.modelFilter, elements.statusFilter, elements.streamFilter]) {
  filter.addEventListener('change', () => {
    state.requestPage = 1;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    loadRequests();
  });
}

// 手机筛选面板里的周期按钮：从周期条克隆（周期条是唯一来源），点击转给原按钮，选中态由上面的处理统一同步。
function mountSheetPeriods() {
  const holder = elements.requestSheetPeriods;
  if (!holder) return;
  holder.replaceChildren();
  for (const source of document.querySelectorAll('.period-bar [data-period]')) {
    const copy = source.cloneNode(true);
    copy.addEventListener('click', () => source.click());
    holder.append(copy);
  }
}
mountSheetPeriods();

// sticky 偏移用实际测量值：顶栏、周期条、请求标题行的高度写进 CSS 变量，换行或窗口变化时重新量。
function syncStickyOffsets() {
  const height = (selector) => document.querySelector(selector)?.getBoundingClientRect().height || 0;
  const root = document.documentElement.style;
  root.setProperty('--topbar-h', `${Math.round(height('.topbar'))}px`);
  root.setProperty('--period-h', `${Math.round(height('.period-bar'))}px`);
  root.setProperty('--request-heading-h', `${Math.round(height('.requests-heading'))}px`);
  watchStickyState();
}

// 吸顶判断：每个 sticky 元素上方有一个零高度哨兵，哨兵滚到吸顶线以上就算吸顶，才给不透明底色（没吸顶时背景透明，和页面融为一体）。
// 吸顶线 = 元素的 top 偏移，随顶栏/周期条高度变化，所以偏移变了就重建观察器。桌面：周期条和标题行；手机：只有标题行。
const stickyTargets = {
  period: () => ({ element: document.querySelector('.period-bar'), offset: () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0 }),
  heading: () => ({ element: document.querySelector('.requests-heading'), offset: () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 0)
    + (window.matchMedia('(min-width: 720px)').matches ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--period-h')) || 0 : 0) }),
};
let stickyObservers = [];
let stickyKey = '';
function stopStickyWatch() {
  for (const observer of stickyObservers) observer.disconnect();
  stickyObservers = [];
  stickyKey = '';
}
function watchStickyState() {
  if (typeof IntersectionObserver !== 'function') return;
  const desktop = window.matchMedia('(min-width: 720px)').matches;
  const names = desktop ? ['period', 'heading'] : ['heading'];
  const plan = names.map((name) => ({ name, ...stickyTargets[name]() }));
  const key = JSON.stringify([desktop, ...plan.map((item) => Math.round(item.offset()))]);
  if (key === stickyKey) return; // 偏移没变，不重建
  stopStickyWatch();
  stickyKey = key;
  for (const { name, element, offset } of plan) {
    const sentinel = document.querySelector(`[data-sticky-sentinel="${name}"]`);
    if (!sentinel || !element) continue;
    const line = Math.round(offset());
    // 根区域上沿下移到吸顶线：哨兵整体落在线以上（bottom <= 0 相对线）即吸顶。隐藏页面里哨兵没有盒子，不算吸顶。
    const observer = new IntersectionObserver(([entry]) => {
      const hidden = !sentinel.getClientRects().length;
      element.classList.toggle('is-stuck', !hidden && !entry.isIntersecting && entry.boundingClientRect.bottom <= line);
    }, { rootMargin: `-${line}px 0px 0px 0px`, threshold: [0, 1] });
    observer.observe(sentinel);
    stickyObservers.push(observer);
  }
}
if (typeof ResizeObserver === 'function') {
  const resizeObserver = new ResizeObserver(syncStickyOffsets);
  for (const selector of ['.topbar', '.period-bar', '.requests-heading']) { const node = document.querySelector(selector); if (node) resizeObserver.observe(node); }
  // 清理路径：页面进入 bfcache 或卸载时断开全部观察器与监听；从 bfcache 恢复时重新建立。
  window.addEventListener('pagehide', () => { resizeObserver.disconnect(); stopStickyWatch(); window.removeEventListener('resize', syncStickyOffsets); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    for (const selector of ['.topbar', '.period-bar', '.requests-heading']) { const node = document.querySelector(selector); if (node) resizeObserver.observe(node); }
    window.addEventListener('resize', syncStickyOffsets);
    syncStickyOffsets();
  });
}
window.addEventListener('resize', syncStickyOffsets);
syncStickyOffsets();
elements.viewUpstreamErrors.addEventListener('click', () => {
  elements.statusFilter.value = 'error';
  state.requestPage = 1;
  window.location.hash = '#requests';
  routeFromHash();
});
elements.requestPageFirst.addEventListener('click', () => {
  if (state.requestPage <= 1) return;
  loadRequests({ page: 1, preserveScroll: true, quiet: false });
});
elements.requestPagePrev.addEventListener('click', () => {
  if (state.requestPage <= 1) return;
  loadRequests({ page: state.requestPage - 1, preserveScroll: true, quiet: false });
});
elements.requestPageNext.addEventListener('click', () => {
  if (state.gatewayMode === 'gateway') {
    if (!state.requestPageData?.hasMore) return;
    loadRequests({ page: state.requestPage + 1, preserveScroll: true, quiet: false });
    return;
  }
  const pageCount = state.requestPageData?.pageCount || 1;
  if (state.requestPage >= pageCount) return;
  loadRequests({ page: state.requestPage + 1, preserveScroll: true, quiet: false });
});
elements.requestPageLast.addEventListener('click', () => {
  if (elements.requestPageLast.disabled) return;
  loadRequests({ last: true, preserveScroll: true, quiet: false });
});
$('#add-channel-button').addEventListener('click', openChannelDialog);
elements.channelHealthSettingsButton.addEventListener('click', openChannelHealthSettings);
$('#channel-health-settings-form').addEventListener('submit', saveChannelHealthSettings);
$('#cost-sync-settings-form').addEventListener('submit', saveCostSyncSettings);
const settingsPageTabs = [...document.querySelectorAll('[data-settings-panel]')];
const selectSettingsPageTab = (selected) => {
  for (const tab of settingsPageTabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.dataset.settingsPanel).hidden = !active;
  }
};
for (const [index, tab] of settingsPageTabs.entries()) {
  tab.addEventListener('click', () => selectSettingsPageTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? settingsPageTabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : settingsPageTabs.length - 1)) % settingsPageTabs.length;
    selectSettingsPageTab(settingsPageTabs[next]); settingsPageTabs[next].focus();
  });
}

elements.settingsWalletRefresh.addEventListener('click', refreshAllWallets);
$('#settings-reduce-motion').addEventListener('change', (event) => {
  // 仅内存：减少动态偏好持久化留待后续切片，刷新后恢复。
  if (event.target.checked) document.documentElement.dataset.motion = 'reduce';
  else delete document.documentElement.dataset.motion;
});
$('#close-request-detail').addEventListener('click', () => elements.requestDetailDialog.close());
elements.requestDetailDialog.addEventListener('click', (event) => {
  if (event.target === elements.requestDetailDialog) elements.requestDetailDialog.close();
});
elements.requestDetailDialog.addEventListener('close', () => {
  const trigger = state.requestDetailTrigger;
  state.requestDetailTrigger = null;
  if (trigger?.isConnected) trigger.focus();
});
$('#refresh-pricing-sync').addEventListener('click', async () => {
  try {
    await api('/api/model-pricing-sync', { method: 'POST', body: '{}' });
    await refresh({ force: true });
    showToast('模型价格同步已执行');
  } catch (error) {
    showToast(error.message, 'error');
  }
});
function requestCloseNewChannel() {
  const dirty = $('#channel-name').value || $('#channel-base-url').value || $('#channel-key').value || state.createEditor?.selected.length;
  if (dirty && !window.confirm('放弃未保存的渠道草稿？')) return;
  elements.channelDialog.close();
}
$('#close-channel-dialog').addEventListener('click', requestCloseNewChannel);
$('#cancel-channel').addEventListener('click', requestCloseNewChannel);
elements.channelDialog.addEventListener('cancel', (event) => { event.preventDefault(); requestCloseNewChannel(); });
elements.channelDialog.addEventListener('close', () => {
  if (state.createEditor) closeEditorDraft(state.createEditor);
  state.createEditor = null;
  state.createModelPicker = null;
  $('#channel-key').value = '';
  $('#channel-model-picker').replaceChildren();
});
$('#channel-models').addEventListener('input', (event) => {
  if (!state.createEditor) return;
  state.createEditor = setSelectedModels(state.createEditor, parseModelList(event.target.value));
  state.createModelPicker.render();
});
for (const selector of ['#channel-base-url', '#channel-type', '#channel-key']) {
  $(selector).addEventListener('input', () => {
    if (!state.createEditor) return;
    state.createEditor = setConnection(state.createEditor, { baseUrl: $('#channel-base-url').value.trim(), protocol: $('#channel-type').value });
    state.createEditor = setCredential(state.createEditor, 'replace', $('#channel-key').value.trim());
    state.createModelPicker.render();
    $('#fetch-models-button').disabled = false;
    $('#fetch-models-status').textContent = '连接参数已变化，请重新拉取；已选模型保留';
  });
}
$('#close-channel-settings').addEventListener('click', requestCloseChannelSettings);
elements.channelSettingsConfigTab.addEventListener('click', () => switchChannelSettingsTab('config'));
elements.channelSettingsWalletTab.addEventListener('click', () => switchChannelSettingsTab('wallet'));
for (const tab of [elements.channelSettingsConfigTab, elements.channelSettingsWalletTab]) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'config' : event.key === 'End' ? 'wallet' : state.settingsTab === 'config' ? 'wallet' : 'config';
    switchChannelSettingsTab(next);
    (next === 'config' ? elements.channelSettingsConfigTab : elements.channelSettingsWalletTab).focus();
  });
}
$('#settings-confirm-cancel').addEventListener('click', () => resolveSettingsConfirm(false));
$('#settings-confirm-accept').addEventListener('click', () => resolveSettingsConfirm(true));
$('#close-routing-confirm').addEventListener('click', () => resolveRoutingConfirm(false));
$('#cancel-routing-confirm').addEventListener('click', () => resolveRoutingConfirm(false));
$('#accept-routing-confirm').addEventListener('click', () => resolveRoutingConfirm(true));
elements.routingConfirmDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  resolveRoutingConfirm(false);
});
elements.routingConfirmDialog.addEventListener('click', (event) => {
  if (event.target === elements.routingConfirmDialog) resolveRoutingConfirm(false);
});
elements.channelSettingsDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!elements.channelSettingsConfirm.hidden) resolveSettingsConfirm(false);
  else requestCloseChannelSettings();
});
elements.channelSettingsDialog.addEventListener('click', (event) => {
  if (event.target !== elements.channelSettingsDialog) return;
  if (!elements.channelSettingsConfirm.hidden) resolveSettingsConfirm(false);
  else requestCloseChannelSettings();
});
$('#fetch-models-button').addEventListener('click', fetchUpstreamModels);
$('#channel-form').addEventListener('submit', createChannel);

// ---- 动态效果：减少动态、数字滚动、缓存命中率仪表、指标卡倾斜 ----
const reducedMotionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function motionReduced() {
  return Boolean(reducedMotionQuery?.matches) || document.documentElement.dataset.motion === 'reduce';
}

// 概览大额汇总（≥ 1 元）双阶小数排版：保留 2 位主显金额，第 3 位起降阶弱化；小于 1 元的小额保持全亮展示，不改变 textContent 原值。
function applyMoneySplit(element) {
  if (!element || element.classList?.contains('is-unpriced')) return;
  if (element.querySelector?.('.unpriced-tag')) return;
  const text = element.textContent || '';
  const match = /^(.*?[1-9][\d,]*\.\d{2})(\d+)$/.exec(text);
  if (!match || typeof document?.createElement !== 'function') return;
  const frac = document.createElement('span');
  frac.className = 'money-frac';
  frac.textContent = match[2];
  element.replaceChildren(match[1], frac);
}

// 只在文本真的变化时滚动（约 600ms，ease-out）；轮询数据不变不重播。
function rollNumber(element) {
  const finalText = element.textContent;
  const isMoneyMetric = element.id === 'metric-cost';
  if (element.dataset.rolled === finalText) {
    if (isMoneyMetric) applyMoneySplit(element);
    return;
  }
  const previousText = element.dataset.rolled;
  element.dataset.rolled = finalText;
  if (element._rollFrame) window.cancelAnimationFrame(element._rollFrame);
  const match = /-?\d[\d,]*(?:\.(\d+))?/.exec(finalText);
  if (motionReduced() || document.hidden || !match || finalText.includes('/')) {
    if (isMoneyMetric) applyMoneySplit(element);
    return;
  }
  const target = Number(match[0].replace(/,/g, ''));
  const decimals = match[1]?.length || 0;
  const grouped = match[0].includes(',');
  const before = previousText && /-?\d[\d,]*(?:\.\d+)?/.exec(previousText);
  const start = before ? Number(before[0].replace(/,/g, '')) : 0;
  if (!Number.isFinite(target) || start === target) {
    if (isMoneyMetric) applyMoneySplit(element);
    return;
  }
  const prefix = finalText.slice(0, match.index);
  const suffix = finalText.slice(match.index + match[0].length);
  const began = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - began) / 600);
    const value = start + (target - start) * (1 - (1 - progress) ** 3);
    const shown = value.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped });
    element.textContent = `${prefix}${shown}${suffix}`;
    element._rollFrame = progress < 1 ? window.requestAnimationFrame(step) : 0;
    if (progress >= 1) {
      element.textContent = finalText;
      if (isMoneyMetric) applyMoneySplit(element);
    }
  };
  element._rollFrame = window.requestAnimationFrame(step);
}

function updateGauge() {
  const gauge = $('#metric-cache-gauge');
  if (!gauge || !state.overview) return;
  const rate = cacheTrendSummary(state.overview.trend || []).cacheHitRate;
  gauge.hidden = !Number.isFinite(rate);
  if (gauge.hidden) return;
  gauge.style.setProperty('--gauge-rate', String(Math.min(1, Math.max(0, rate))));
  gauge.querySelector('.gauge-text').textContent = `${Math.round(rate * 100)}%`;
  gauge.setAttribute('aria-label', `缓存命中率 ${formatCacheRate(rate)}`);
}

// 指标卡克制悬停态：遵循减少动态开关，不再做夸张的 3D 倾斜与白光斑。
function tiltCard(event) {
  const card = event.target.closest?.('.metric');
  if (!card || event.pointerType !== 'mouse' || motionReduced()) return;
  card.classList.add('is-tilted');
}

function untiltCards(event) {
  const card = event.target.closest?.('.metric');
  if (!card) return;
  card.classList.remove('is-tilted');
}

// ---- 请求页筛选：手机底部抽屉 + 已生效筛选标签 ----
const filterControls = [
  [elements.channelFilter, '渠道'], [elements.poolFilter, '分组'], [elements.modelFilter, '模型'], [elements.statusFilter, '结果'], [elements.streamFilter, '类型'],
];

function renderActiveFilters() {
  const holder = $('#active-filters');
  const count = $('#request-filter-count');
  const reset = $('#request-filter-reset');
  if (!holder) return;
  holder.replaceChildren();
  let active = 0;
  for (const [select, label] of filterControls) {
    if (!select.value) continue;
    active += 1;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'filter-chip';
    chip.textContent = `${label}：${select.selectedOptions?.[0]?.textContent || select.value} ×`;
    chip.setAttribute('aria-label', `移除筛选 ${label}`);
    chip.addEventListener('click', () => {
      select.value = '';
      select.dispatchEvent(new Event('change'));
    });
    holder.append(chip);
  }
  count.hidden = active === 0;
  count.textContent = String(active);
  if (reset) reset.hidden = active === 0;
}

$('#request-filter-reset')?.addEventListener('click', () => {
  for (const [select] of filterControls) select.value = '';
  state.requestPage = 1;
  renderActiveFilters();
  window.scrollTo({ top: 0, behavior: motionReduced() ? 'instant' : 'smooth' });
  loadRequests({ quiet: false });
});

document.addEventListener('click', (event) => {
  const clickedMore = event.target.closest?.('.channel-more');
  for (const menu of document.querySelectorAll('.channel-more[open]')) {
    if (menu !== clickedMore) menu.open = false;
  }
});

const periodContextTitles = { overview: '系统概览', channels: '上游渠道', requests: '请求日志', settings: '系统设置' };
function syncPeriodContext(name) {
  const label = $('#period-context-label');
  if (label) label.textContent = periodContextTitles[name] || '系统概览';
}

function setFilterSheet(open) {
  document.querySelector('.requests-heading')?.classList.toggle('is-sheet-open', open);
  $('#request-filters').classList.toggle('is-open', open);
  $('#filter-backdrop').hidden = !open;
  $('#request-filter-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#channel-filter').focus();
  else $('#request-filter-toggle').focus();
}

$('#request-filter-toggle').addEventListener('click', () => setFilterSheet(!$('#request-filters').classList.contains('is-open')));
$('#request-filter-done').addEventListener('click', () => setFilterSheet(false));
$('#filter-backdrop').addEventListener('click', () => setFilterSheet(false));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if ($('#request-filters').classList.contains('is-open')) setFilterSheet(false);
  for (const menu of document.querySelectorAll('.channel-more[open]')) menu.open = false;
});
for (const [select] of filterControls) select.addEventListener('change', renderActiveFilters);

// 渲染完一页之后的统一后处理：数字滚动、金额双阶小数、仪表、筛选标签、星图。
function afterRender(name) {
  document.body.dataset.loaded = 'true';
  syncPeriodContext(name);
  if (name === 'overview') {
    for (const element of document.querySelectorAll('.metric strong')) rollNumber(element);
    applyMoneySplit(elements.modelTotal);
    for (const amount of document.querySelectorAll('.model-amount')) applyMoneySplit(amount);
    updateGauge();
    updateStarMap();
  } else if (name === 'requests') {
    renderActiveFilters();
  }
}

document.querySelector('.metric-matrix')?.addEventListener('pointermove', tiltCard);
document.querySelector('.metric-matrix')?.addEventListener('pointerout', untiltCards);
elements.trendChart.addEventListener('pointermove', trendPointer);
elements.trendChart.addEventListener('pointerleave', trendPointerLeave);

// ---- 路由星图：canvas 2D 手工透视投影（不用 WebGL、不加依赖） ----
const starColors = { healthy: '#7fd1b9', failing: '#f08a84', unknown: '#9a948a', disabled: '#5d5a56' };
const starStateLabels = { healthy: '健康', failing: '失败', unknown: '未知', disabled: '停用' };

function starHealth(channel) {
  if (!channel.enabled || channel.state === 'disabled') return 'disabled';
  if (['failing', 'exhausted', 'auth_invalid'].includes(channel.state)) return 'failing';
  if (['healthy', 'recovered', 'available'].includes(channel.state)) return 'healthy';
  return 'unknown';
}

// 把渠道按所属池归组；请求量与成本取当前周期（含合并进来的旧 New API 历史，由概览数据提供）。
function buildStarModel(channels) {
  const pools = new Map();
  for (const channel of channels) {
    const name = channel.routingPool || channel.type || '其他';
    if (!pools.has(name)) pools.set(name, { name, family: providerFamilyOf(channel), channels: [], requests: 0, cost: 0, costKnown: false });
    const pool = pools.get(name);
    const requests = Number(channel.requests) || 0;
    const cost = Number(channel.estimatedCost) || 0;
    pool.requests += requests;
    pool.cost += cost;
    pool.costKnown = pool.costKnown || cost > 0;
    pool.channels.push({ id: channel.id, name: channel.name, requests, cost, costKnown: cost > 0, health: starHealth(channel) });
  }
  const order = ['Claude', 'OpenAI', 'xAI', 'DeepSeek', 'Gemini', 'Moonshot', 'Zhipu'];
  const rank = (name) => (order.includes(name) ? order.indexOf(name) : order.length);
  const list = [...pools.values()].sort((left, right) => rank(left.name) - rank(right.name) || left.name.localeCompare(right.name));
  const all = list.flatMap((pool) => pool.channels);
  return {
    pools: list,
    totalRequests: all.reduce((sum, channel) => sum + channel.requests, 0),
    maxRequests: Math.max(1, ...all.map((channel) => channel.requests)),
    maxPoolRequests: Math.max(1, ...list.map((pool) => pool.requests)),
    maxCost: Math.max(0, ...all.map((channel) => channel.cost)),
  };
}

// 视觉隐藏的读屏摘要（canvas 本身 aria-hidden）。
function starSummary(model) {
  if (!model.pools.length) return '路由星图：暂无渠道数据。';
  const parts = model.pools.map((pool) => `${pool.name} 池 ${pool.channels.length} 个渠道，${pool.requests} 次请求，成本${pool.costKnown ? formatCost(pool.cost) : '未定价'}，`
    + pool.channels.map((channel) => `${channel.name}（${starStateLabels[channel.health]}，${channel.requests} 次）`).join('、'));
  return `路由星图：${model.pools.length} 个厂商池。${parts.join('；')}。`;
}

function createStarMap(env) {
  const ctx = env.ctx;
  const view = { yaw: 0.4, pitch: 0.55, width: 0, height: 0, dpr: 1 };
  let model = { pools: [], maxRequests: 1, maxPoolRequests: 1, maxCost: 0, totalRequests: 0 };
  let particles = [];
  let hits = [];
  let hover = null;
  let frameId = 0;
  let drag = null;

  function project(x, y, z, ringR) {
    const cosY = Math.cos(view.yaw), sinY = Math.sin(view.yaw);
    const x1 = x * cosY + z * sinY, z1 = -x * sinY + z * cosY;
    const cosX = Math.cos(view.pitch), sinX = Math.sin(view.pitch);
    const y2 = y * cosX - z1 * sinX, z2 = y * sinX + z1 * cosX;
    const depth = 1 / (1 - z2 / (ringR * 4));
    return { sx: view.width / 2 + x1 * depth, sy: view.height / 2 + y2 * depth, depth, z: z2 };
  }

  function shouldRun() {
    return !env.reduced() && env.isVisible() && env.isActive();
  }

  let lastT = 0;

  // 池节点排在倾斜轨道环上随时间自转；渠道是池节点的卫星。
  function layout(t) {
    const ringR = Math.max(60, Math.min(view.width * 0.34, view.height * 0.55));
    const spin = t * 0.00006;
    const count = model.pools.length;
    const items = [];
    const lines = [];
    const core = project(0, 0, 0, ringR);
    model.pools.forEach((pool, i) => {
      const a = (i / count) * Math.PI * 2 + spin;
      const px = Math.cos(a) * ringR, pz = Math.sin(a) * ringR;
      pool.pos = { x: px, y: 0, z: pz };
      const p = project(px, 0, pz, ringR);
      const color = (channelColors[pool.family] || channelColors.unknown)[0];
      items.push({ kind: 'pool', ref: pool, sx: p.sx, sy: p.sy, z: p.z, r: (9 + 6 * Math.sqrt(pool.requests / model.maxPoolRequests)) * p.depth, color, label: pool.name });
      lines.push([core, p, 0.14]);
      const m = pool.channels.length;
      const rs = ringR * (m > 4 ? 0.3 : 0.24);
      pool.channels.forEach((channel, j) => {
        const b = (j / m) * Math.PI * 2 + t * 0.00022 + i;
        channel.pos = { x: px + Math.cos(b) * rs, y: Math.sin(b) * rs * 0.5, z: pz + Math.sin(b) * rs * 0.85 };
        const c = project(channel.pos.x, channel.pos.y, channel.pos.z, ringR);
        items.push({ kind: 'channel', ref: channel, pool, sx: c.sx, sy: c.sy, z: c.z, r: (3 + 8 * Math.sqrt(channel.requests / model.maxRequests)) * c.depth, color: starColors[channel.health] });
        lines.push([p, c, 0.1]);
      });
    });
    return { ringR, core, items, lines };
  }

  // 粒子沿 核心 → 池 → 渠道 流动；绿色粒子的比例 = 该渠道成本占最大渠道成本的比例。
  function drawParticles(t, ringR) {
    for (const particle of particles) {
      const p = (particle.phase + t * particle.speed) % 1;
      const from = p < 0.5 ? { x: 0, y: 0, z: 0 } : particle.pool.pos;
      const to = p < 0.5 ? particle.pool.pos : particle.channel.pos;
      const k = p < 0.5 ? p * 2 : (p - 0.5) * 2;
      const q = project(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, from.z + (to.z - from.z) * k, ringR);
      ctx.fillStyle = particle.copper ? 'rgba(160, 211, 115, 0.95)' : 'rgba(243, 239, 231, 0.55)';
      ctx.beginPath();
      ctx.arc(q.sx, q.sy, 1.5 * q.depth, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function draw(t, animated) {
    if (!view.width || !view.height) return;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, view.height);
    hits = [];
    if (!model.pools.length) return;
    const { ringR, core, items, lines } = layout(t);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(243, 239, 231, 0.10)';
    ctx.beginPath();
    for (let i = 0; i <= 96; i += 1) {
      const a = (i / 96) * Math.PI * 2;
      const q = project(Math.cos(a) * ringR, 0, Math.sin(a) * ringR, ringR);
      if (i === 0) ctx.moveTo(q.sx, q.sy); else ctx.lineTo(q.sx, q.sy);
    }
    ctx.stroke();
    for (const [a, b, alpha] of lines) {
      ctx.strokeStyle = `rgba(243, 239, 231, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }
    if (animated) drawParticles(t, ringR);
    items.sort((left, right) => left.z - right.z);
    for (const item of items) {
      const active = hover && hover.ref === item.ref;
      ctx.fillStyle = item.color;
      ctx.globalAlpha = item.kind === 'channel' && item.ref.health === 'disabled' ? 0.55 : 1;
      ctx.beginPath();
      ctx.arc(item.sx, item.sy, item.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      if (item.kind === 'pool' || active) {
        ctx.strokeStyle = active ? '#f3efe7' : item.color;
        ctx.lineWidth = active ? 2 : 1;
        ctx.beginPath();
        ctx.arc(item.sx, item.sy, item.r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (item.kind === 'pool') {
        ctx.fillStyle = '#f3efe7';
        ctx.font = '12px "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(item.label, item.sx, item.sy + item.r + 18);
      }
      hits.push({ ...item });
    }
    const pulse = animated ? 1 + Math.sin(t * 0.002) * 0.08 : 1;
    const glow = ctx.createRadialGradient(core.sx, core.sy, 2, core.sx, core.sy, 30 * pulse);
    glow.addColorStop(0, 'rgba(127, 209, 185, 0.95)');
    glow.addColorStop(0.45, 'rgba(127, 209, 185, 0.28)');
    glow.addColorStop(1, 'rgba(127, 209, 185, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(core.sx, core.sy, 30 * pulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#97dcc8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(core.sx, core.sy, 11, 0, Math.PI * 2);
    ctx.stroke();
  }

  function frame(now) {
    frameId = 0;
    lastT = now;
    draw(now, true);
    if (shouldRun()) frameId = env.requestFrame(frame);
  }

  function start() {
    if (frameId) return;
    if (!shouldRun()) { draw(lastT, false); return; }
    frameId = env.requestFrame(frame);
  }

  function stop() {
    if (frameId) env.cancelFrame(frameId);
    frameId = 0;
  }

  function setModel(next) {
    model = next;
    particles = [];
    const cap = Math.min(env.particleCap(), Math.max(0, model.totalRequests));
    if (model.totalRequests > 0 && cap > 0) {
      let serial = 0;
      for (const pool of model.pools) {
        for (const channel of pool.channels) {
          const share = channel.requests / model.totalRequests;
          const amount = channel.requests > 0 ? Math.max(1, Math.round(share * cap)) : 0;
          const copperShare = channel.costKnown && model.maxCost > 0 ? channel.cost / model.maxCost : 0;
          for (let i = 0; i < amount && particles.length < cap; i += 1) {
            serial += 1;
            particles.push({ pool, channel, phase: (serial * 0.618034) % 1, speed: 0.00005 + ((serial * 0.37) % 1) * 0.00004, copper: i / amount < copperShare });
          }
        }
      }
    }
    if (!frameId) draw(lastT, false);
  }

  function resize() {
    const size = env.size();
    if (!size.width || !size.height) return;
    view.width = size.width;
    view.height = size.height;
    view.dpr = Math.min(2, size.dpr || 1);
    env.canvas.width = Math.round(size.width * view.dpr);
    env.canvas.height = Math.round(size.height * view.dpr);
    if (!frameId) draw(lastT, false);
  }

  function pick(x, y) {
    let best = null;
    for (let i = hits.length - 1; i >= 0; i -= 1) {
      const hit = hits[i];
      const distance = Math.hypot(hit.sx - x, hit.sy - y);
      if (distance <= hit.r + 5 && (!best || distance < best.distance)) best = { hit, distance };
    }
    return best?.hit || null;
  }

  function tipText(hit) {
    if (hit.kind === 'pool') return `${hit.ref.name} 池 · ${hit.ref.requests} 次请求 · ${hit.ref.costKnown ? formatCost(hit.ref.cost) : '未定价'}（点击查看渠道）`;
    return `${hit.ref.name} · ${hit.ref.requests} 次请求 · ${hit.ref.costKnown ? formatCost(hit.ref.cost) : '未定价'} · ${starStateLabels[hit.ref.health]}`;
  }

  function pointerMove(x, y) {
    if (drag) {
      drag.moved += Math.abs(x - drag.x) + Math.abs(y - drag.y);
      view.yaw += (x - drag.x) * 0.01;
      view.pitch = Math.min(1.2, Math.max(0.1, view.pitch + (y - drag.y) * 0.008));
      drag.x = x;
      drag.y = y;
      if (!frameId) draw(lastT, false);
      return;
    }
    const hit = pick(x, y);
    const changed = (hit?.ref || null) !== (hover?.ref || null);
    hover = hit;
    if (hit) env.showTip(tipText(hit), hit.sx, hit.sy - hit.r);
    else env.hideTip();
    if (changed && !frameId) draw(lastT, false);
  }

  function pointerDown(x, y) { drag = { x, y, moved: 0 }; }

  function pointerUp(x, y) {
    const wasTap = drag && drag.moved < 6;
    drag = null;
    if (!wasTap) return;
    const hit = pick(x, y);
    if (hit?.kind === 'pool') env.navigate(hit.ref.name);
  }

  function pointerLeave() {
    drag = null;
    hover = null;
    env.hideTip();
    if (!frameId) draw(lastT, false);
  }

  return { setModel, resize, start, stop, pointerMove, pointerDown, pointerUp, pointerLeave, isRunning: () => frameId !== 0, view };
}

const starState = { map: null, visible: true };

function goToPool(poolName) {
  window.location.hash = '#channels';
  routeFromHash();
  // showPage 会同步还原滚动位置，等它完成后再滚到该池分组。
  window.requestAnimationFrame(() => {
    const row = [...document.querySelectorAll('.channel-group-row')].find((item) => item.dataset.pool === poolName);
    row?.scrollIntoView({ block: 'start', behavior: motionReduced() ? 'auto' : 'smooth' });
  });
}

function ensureStarMap() {
  if (starState.map) return starState.map;
  const canvas = $('#starmap-canvas');
  const stage = $('#starmap-stage');
  const tip = $('#starmap-tip');
  if (!canvas || !canvas.getContext) return null;
  const mobile = () => window.matchMedia('(max-width: 719px)').matches;
  const local = (event) => { const box = canvas.getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
  const map = createStarMap({
    canvas,
    ctx: canvas.getContext('2d'),
    size: () => { const box = stage.getBoundingClientRect(); return { width: box.width, height: box.height, dpr: window.devicePixelRatio || 1 }; },
    particleCap: () => (mobile() ? 120 : 300),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (id) => window.cancelAnimationFrame(id),
    reduced: motionReduced,
    isVisible: () => starState.visible && !document.hidden,
    isActive: () => state.page === 'overview',
    navigate: goToPool,
    showTip: (text, x, y) => { tip.textContent = text; tip.hidden = false; tip.style.setProperty('--tip-x', `${Math.round(x)}px`); tip.style.setProperty('--tip-y', `${Math.round(y)}px`); },
    hideTip: () => { tip.hidden = true; },
  });
  canvas.addEventListener('pointermove', (event) => map.pointerMove(...local(event)));
  canvas.addEventListener('pointerdown', (event) => { canvas.setPointerCapture?.(event.pointerId); map.pointerDown(...local(event)); });
  canvas.addEventListener('pointerup', (event) => map.pointerUp(...local(event)));
  canvas.addEventListener('pointerleave', () => map.pointerLeave());
  canvas.addEventListener('pointercancel', () => map.pointerLeave());
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((entries) => {
      starState.visible = entries.some((entry) => entry.isIntersecting);
      if (starState.visible) { map.resize(); map.start(); } else map.stop();
    }).observe(stage);
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => map.resize()).observe(stage);
  document.addEventListener('visibilitychange', () => { if (document.hidden) map.stop(); else map.start(); });
  const restart = () => { map.stop(); map.start(); };
  reducedMotionQuery?.addEventListener?.('change', restart);
  new MutationObserver(restart).observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] });
  starState.map = map;
  return map;
}

function updateStarMap() {
  const map = ensureStarMap();
  if (!map || !state.overview) return;
  const model = buildStarModel(state.overview.channels || []);
  $('#starmap-summary').textContent = starSummary(model);
  $('#starmap-empty').hidden = model.pools.length > 0;
  map.resize();
  map.setModel(model);
  map.start();
}

// ---- 价格页等距立柱：DOM 常驻，切换渠道/模型时只改 --h（transform 过渡升降） ----
if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
window.addEventListener('hashchange', routeFromHash);
routeFromHash();

loadGatewayConfiguration().then(() => refresh()).catch((error) => {
  elements.connection.textContent = '网关模式核对失败';
  showToast(error.message, 'error');
});
setInterval(() => {
  if (document.hidden) return;
  refresh({ quiet: true });
}, 60_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - state.lastRefreshAt >= 60_000) refresh({ quiet: true });
});
