import { parseModels, matchingModels, modelPage } from './model-state.mjs';

const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const channelColor = (value) => /^(openai|openai-secondary|claude|xai|deepseek|gemini|danger)$/.test(value) ? `var(--${value})` : 'var(--muted)';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'reduce';
const pools = ['OpenAI', 'Claude', 'xAI', 'DeepSeek', 'Gemini'];
const channels = [
  { id: 'aster', name: 'Aster OpenAI', pool: 'OpenAI', role: '主用', enabled: true, models: ['gpt-5.6', 'gpt-5.6-mini'], rate: '0.32×', balance: '¥ 86.42', health: '100%', latency: '680 ms', color: 'openai', priority: 100 },
  { id: 'north', name: '北屿 Claude', pool: 'Claude', role: '主用', enabled: true, models: ['claude-opus-5', 'claude-sonnet-5'], rate: '0.28×', balance: '¥ 42.80', health: '99.2%', latency: '1.2 s', color: 'claude', priority: 100 },
  { id: 'grok', name: 'TokenShop xAI', pool: 'xAI', role: '主用', enabled: true, models: ['grok-4.6', 'grok-4.5'], rate: '0.40×', balance: '¥ 27.36', health: '100%', latency: '920 ms', color: 'xai', priority: 100 },
  { id: 'deep', name: 'DeepSeek Direct', pool: 'DeepSeek', role: '主用', enabled: true, models: ['deepseek-v4.1-flash'], rate: '1.00×', balance: '¥ 9.68', health: '100%', latency: '420 ms', color: 'deepseek', priority: 100 },
  { id: 'gemini', name: 'Gemini Hub', pool: 'Gemini', role: '主用', enabled: true, models: ['gemini-2.5-pro'], rate: '0.45×', balance: '¥ 58.00', health: '98.6%', latency: '860 ms', color: 'gemini', priority: 100 },
  { id: 'backup', name: 'OpenAI 备用', pool: 'OpenAI', role: '副用', enabled: true, models: ['gpt-5.6'], rate: '0.36×', balance: '¥ 24.00', health: '100%', latency: '740 ms', color: 'openai-secondary', priority: 50 },
  { id: 'zzz', name: 'zzz', pool: 'Claude', role: '停用', enabled: false, models: ['claude-opus-5'], rate: '0.30×', balance: '¥ 0.00', health: '', latency: '', color: 'danger', priority: 10 },
];
const requests = [
  { time: '14:23:08', channel: 'Aster OpenAI', model: 'gpt-5.6', effort: 'xhigh', status: '成功', input: '1,024', output: '872', read: '52,992', write: '', cost: '¥ 0.0312', latency: '3.42 s', outputTokensPerSecond: 872 / 3.42 },
  { time: '14:21:46', channel: '北屿 Claude', model: 'claude-opus-5', effort: 'max', status: '成功', input: '2,180', output: '1,283', read: '87,424', write: '4,096', cost: '¥ 0.1268', latency: '8.20 s', outputTokensPerSecond: 1283 / 8.2 },
  { time: '14:18:32', channel: 'TokenShop xAI', model: 'grok-4.6', effort: 'high', status: '成功', input: '512', output: '1,016', read: '39,936', write: '', cost: '¥ 0.0204', latency: '4.65 s', outputTokensPerSecond: 1016 / 4.65 },
  { time: '14:15:20', channel: 'DeepSeek Direct', model: 'deepseek-v4.1-flash', effort: '', status: '成功', input: '328', output: '644', read: '12,800', write: '', cost: '¥ 0.0026', latency: '2.18 s', outputTokensPerSecond: 644 / 2.18 },
  { time: '14:09:12', channel: 'Gemini Hub', model: 'gemini-2.5-pro', effort: 'high', status: '流中断', input: '2,048', output: '640', read: '', write: '', cost: '¥ 0.0140', latency: '6.72 s', outputTokensPerSecond: null },
];
const initialModels = [...new Set(channels.flatMap((c) => c.models))];
const catalog = [...initialModels, ...Array.from({ length: 1000 - initialModels.length }, (_, i) => `lab-model-${String(i + 1).padStart(4, '0')}`)];
const state = { page: 'overview', period: 'today', pool: '全部', query: '', editor: null, modelQuery: '', onlySelected: false, modelPage: 0, run: 0, interval: 10 };
let toastTimer;
let opener;
let pageAnimation;
const visited = new Set();

function notify(message) {
  clearTimeout(toastTimer);
  message = message.replace(/^✓\s*/, '');
  if ($('#editor').open) { $('#editor-status').textContent = message; return; }
  $('#announcer').textContent = message;
  $('#toast-text').textContent = message;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
}

function show(dialog) { dialog.showModal(); }
async function dismiss(dialog) {
  if (!dialog.open || dialog.dataset.closing) return;
  dialog.dataset.closing = 'true';
  if (!reduced() && !document.hidden) {
    const mobile = matchMedia('(max-width:719px), (max-height:500px) and (pointer:coarse)').matches;
    const target = dialog.id === 'discard' ? 'scale(.98)' : mobile ? 'translateY(16px)' : 'translateX(24px)';
    const animation = dialog.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: target }], { duration: dialog.id === 'discard' ? 160 : 180, easing: 'ease-in' });
    let deadline;
    // Embedded browsers may suspend animation completion while timers still run.
    await Promise.race([animation.finished.catch(() => {}), new Promise((resolve) => { deadline = setTimeout(resolve, 240); })]);
    clearTimeout(deadline); animation.cancel();
  }
  dialog.close();
  delete dialog.dataset.closing;
}

const periods = () => `<select id="period" aria-label="数据时间段">${[['today', '今天'], ['yesterday', '昨天'], ['24h', '24 小时'], ['7d', '7 天'], ['30d', '30 天']].map(([v, t]) => `<option value="${v}" ${v === state.period ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
const heading = (title, subtitle, actions = '') => `<div class="page-heading"><div><span class="eyebrow">工作台 <span class="online-dot"></span> 运行正常</span><h1 tabindex="-1">${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${actions}</div></div>`;
const status = (enabled) => `<span class="status ${enabled ? 'healthy' : 'muted'}"><i></i>${enabled ? '可用' : '已停用'}</span>`;

function overview() {
  const metrics = [['采购成本', '¥ 12.84', '模型测试 ¥ 0.26', 'money'], ['请求', '1,286', '99.4% 成功', ''], ['缓存命中率', '94.8%', '按已知输入 Token 加权', 'read'], ['平均首字', '742', '毫秒 · TTFT', 'latency'], ['可用渠道', '6 / 7', '5 个独立路由池', ''], ['输入 / 输出', '1.82M / 426K', '未缓存输入 / 总输出', ''], ['缓存读取', '32.4M', '缓存读 Token', 'read'], ['缓存写入', '148K', '缓存写 Token', 'write']];
  return heading('运行概览', '今天的调用、成本与上游状态。', periods()) + `<section class="metrics" aria-label="关键指标">${metrics.map(([label, value, note, kind]) => `<article class="metric ${kind}"><span>${label}</span><strong>${escape(value).replace(' / ', ' /<wbr> ')}</strong><small>${note}</small></article>`).join('')}</section>
  <div class="analytics"><section class="panel"><header class="panel-heading"><h2>渠道成本分布</h2><div class="segments" aria-label="成本分布"><button data-distribution="channel" aria-pressed="true">按渠道</button><button data-distribution="test" aria-pressed="false">模型测试</button></div></header><div id="cost-bars" class="cost-bars">${costBars()}</div><footer class="panel-note">请求时点官方价 × 当前确认采购倍率</footer></section>
  <section class="panel"><header class="panel-heading"><h2>缓存命中率</h2><select id="trend-channel" aria-label="趋势渠道"><option>全部渠道</option>${channels.filter((c) => c.enabled).map((c) => `<option>${escape(c.name)}</option>`).join('')}</select></header><div class="chart-summary"><strong id="trend-rate">94.8<small>%</small></strong><span>输入 1.82M · 输出 426K<br><em class="read">缓存读 32.4M</em> · <em class="write">写 148K</em></span></div><div class="trend-frame"><div class="trend-y"><span>100%</span><span>50%</span><span>0%</span></div><svg class="trend" viewBox="38 0 562 118" preserveAspectRatio="none" role="img" aria-label="今天缓存命中率趋势，约百分之九十五"><g class="grid-lines"><path d="M38 15H590M38 60H590M38 105H590"/></g><path class="trend-line" d="M38 23L75 20L112 26L150 23L186 25L222 20L260 22L298 40L335 28L372 23L410 21L448 28L485 22L520 24L555 20L588 22"/><circle cx="588" cy="22" r="3" class="trend-point"/></svg><div class="trend-x"><span>00:00</span><span>06:00</span><span>12:00</span><span>现在</span></div></div></section></div>
  <section class="panel pool-panel"><header class="panel-heading"><h2>主用路由池</h2><button class="text-button" data-go="channels">管理渠道 →</button></header><div class="pool-grid">${channels.filter((c) => c.role === '主用').map((c) => `<div class="pool-summary" style="--channel:${channelColor(c.color)}"><span>${escape(c.pool)}<span class="status healthy"><i></i>在线</span></span><strong>${escape(c.name)}</strong><small>上游探活 ${escape(c.health)} · ${escape(c.latency)}</small></div>`).join('')}</div></section><div class="footnote">演示数据 · 更新于 14:23:10 · 自动探活每 10 分钟</div>`;
}

function costBars(test = false) {
  const rows = test ? [['模型测试', '¥ 0.26', 0.52, '#e7b38c']] : channels.filter((c) => c.enabled).slice(0, 5).map((c, i) => [c.name, ['¥ 6.42', '¥ 3.08', '¥ 1.67', '¥ 0.42', '¥ 1.25'][i], [0.92, 0.44, 0.24, 0.06, 0.18][i], c.color]);
  return rows.map(([name, cost, share, color]) => `<div class="cost-row"><span>${escape(name)}</span><span class="bar-track"><i style="--share:${share};--channel:${channelColor(color)}"></i></span><strong>${escape(cost)}</strong></div>`).join('');
}

function channelRows() {
  const list = channels.filter((c) => (state.pool === '全部' || c.pool === state.pool) && `${c.name} ${c.models.join(' ')}`.toLowerCase().includes(state.query.toLowerCase()));
  return list.length ? list.map((c) => `<tr style="--channel:${channelColor(c.color)}"><td class="identity"><strong><i class="channel-mark"></i>${escape(c.name)}</strong><small>${escape(c.pool)} <span class="badge">${escape(c.enabled ? c.role : '已停用')}</span></small></td><td data-label="模型"><button class="model-link" data-edit="${escape(c.id)}" data-edit-tab="models">${c.models.length} 个模型 <span>↗</span></button><small class="model-id">${escape(c.models[0])}</small></td><td data-label="路由"><strong>${escape(c.enabled ? c.role : '已停用')}</strong><small>优先级 ${escape(c.priority)} · 权重 10</small></td><td data-label="成本与余额"><strong>${escape(c.rate)}</strong><small>余额 <em class="money">${escape(c.balance)}</em></small></td><td data-label="自动探活">${status(c.enabled)}<small>${c.enabled ? `${escape(c.health)} · ${escape(c.latency)}` : '自动探活已暂停'}</small></td><td class="row-actions"><button class="button" data-edit="${escape(c.id)}">设置</button><details class="more"><summary aria-label="${escape(c.name)} 更多操作">···</summary><div class="action-menu"><button data-probe="${escape(c.id)}">单次检测</button><button data-toggle="${escape(c.id)}">${c.enabled ? '停用渠道' : '启用渠道'}</button><button data-primary="${escape(c.id)}" ${!c.enabled ? 'disabled' : ''}>设为唯一主用</button></div></details></td></tr>`).join('') : '<tr><td colspan="6" class="empty-state">没有匹配的渠道，可以更换筛选条件。</td></tr>';
}

function channelPage() {
  return heading('渠道管理', '按池管理主副渠道，模型目录与已选模型分别保留。', '<button class="button primary" id="add-channel">＋ 新增渠道</button>') + `<section class="panel"><div class="toolbar"><div class="pool-filters" role="group" aria-label="路由池筛选">${['全部', ...pools].map((p) => `<button data-pool="${p}" aria-pressed="${p === state.pool}">${p}</button>`).join('')}</div><input type="search" id="channel-search" aria-label="搜索渠道或模型" placeholder="搜索渠道或模型" value="${escape(state.query)}"></div><table class="data-table channels"><thead><tr><th>渠道</th><th>模型</th><th>路由</th><th>成本与余额</th><th>自动探活</th><th>操作</th></tr></thead><tbody id="channels-body">${channelRows()}</tbody></table></section><div class="footnote">手动停用后停止自动探活，历史请求和费用保留。</div>`;
}

function pricingPage() {
  return heading('模型与价格', '只显示已配置渠道的模型，价格来源和计价单位明确。') + `<section class="panel pricing-panel"><div class="toolbar"><label>渠道<select id="price-channel">${channels.map((c) => `<option value="${escape(c.id)}">${escape(c.name)}</option>`).join('')}</select></label><label>模型<select id="price-model"></select></label><span class="badge">示例价格</span></div><div class="price-summary"><span class="eyebrow">倍率后的采购单价</span><h2 id="price-model-title">gpt-5.6</h2><p>官方价格 × <strong id="price-multiplier">0.32×</strong> · CNY / 百万 Token</p></div><div class="price-grid">${[['输入', '¥ 5.76'], ['输出', '¥ 34.56'], ['缓存读取', '¥ 0.576'], ['缓存写入', '']].map(([label, value]) => `<div><span>${label}</span><strong class="money">${value || '未知'}</strong>${!value ? '<small>上游未提供该项价格</small>' : ''}</div>`).join('')}</div><footer class="panel-note">设计原型使用合成价格，不代表当前渠道报价。</footer></section>`;
}

function outputRate(r) {
  return r.status === '成功' && Number.isFinite(r.outputTokensPerSecond) && r.outputTokensPerSecond > 0
    ? `约 ${r.outputTokensPerSecond.toFixed(1)} tok/s` : '—';
}

function requestRows(filter = '') {
  return requests.map((r, index) => ({ ...r, index })).filter((r) => !filter || r.status === filter).map((r) => `<tr><td class="request-time"><button class="text-button" data-detail="${r.index}">${escape(r.time)} ↗</button><small>今天 · 流式</small></td><td class="identity"><strong>${escape(r.channel)}</strong><small class="model-id request-model-${/^gpt-/.test(r.model) ? 'openai' : /^claude-/.test(r.model) ? 'claude' : /^grok-/.test(r.model) ? 'xai' : /^deepseek-/.test(r.model) ? 'deepseek' : /^gemini-/.test(r.model) ? 'gemini' : 'unknown'}">${escape(r.model)}</small></td><td data-label="结果"><span class="badge ${r.status === '成功' ? 'success' : 'warning'}">${escape(r.status)}</span><small>推理强度 ${escape(r.effort || '—')}</small></td><td data-label="Token"><div class="token-inline"><span>入 ${escape(r.input)}</span><span>出 ${escape(r.output)}</span><span class="read">读 ${escape(r.read || '—')}</span><span class="write">写 ${escape(r.write || '—')}</span></div></td><td data-label="成本"><strong class="money">${escape(r.cost)}</strong><small>${r.status === '成功' ? '已知用量' : '部分用量'}</small></td><td data-label="延迟" class="latency"><strong>${escape(r.latency)}</strong><small>首字 0.74 s</small><small title="全请求平均输出速率 = 输出 Token ÷ 总耗时；含等待，输出可能含推理 Token；New API 耗时为秒级估算">${outputRate(r)}</small></td></tr>`).join('');
}

function requestPage() {
  return heading('请求日志', '成功、失败与中断分别记录；已知用量保留。', periods()) + `<section class="panel"><div class="toolbar"><strong>最近请求 <span class="muted">5</span></strong><label class="inline-label">结果<select id="request-filter"><option value="">全部结果</option><option>成功</option><option>流中断</option></select></label></div><table class="data-table requests"><thead><tr><th>时间</th><th>渠道 / 模型</th><th>结果 / 推理</th><th>Token 明细</th><th>采购成本</th><th>延迟</th></tr></thead><tbody id="request-body">${requestRows()}</tbody></table><footer class="pagination"><span>1–5，共 5 条</span><div><button class="button" disabled>上一页</button><button class="button" disabled>下一页</button></div></footer></section>`;
}

function settingsPage() {
  return heading('设置', '只保留日常需要的控制。') + `<section class="panel settings-panel"><div class="setting-row"><div><h2>自动探活</h2><p>仅检测启用渠道，不使用业务请求成功率代替。</p></div><form id="probe-settings"><label class="inline-label"><input id="probe-interval" aria-label="探活间隔分钟" type="number" min="1" max="1440" value="${state.interval}" required>分钟</label><button class="button primary">保存间隔</button></form></div><div class="setting-row"><div><h2>减少动态效果</h2><p>系统选择减少动态时自动生效；交互反馈仍会保留。</p></div><label class="switch"><input id="reduce-motion" type="checkbox" ${document.documentElement.dataset.motion === 'reduce' ? 'checked' : ''}><span>减少动态效果</span></label></div><div class="setting-row"><div><h2>调用令牌</h2><p>管理权限与模型调用权限分开，密钥不回填。</p></div><span class="badge">原型不持有令牌</span></div></section><div class="footnote">此设计原型不连接实际网关，操作仅影响当前页面。</div>`;
}

function render(animate = false) {
  pageAnimation?.cancel();
  $('#main').dataset.firstVisit = String(!visited.has(state.page));
  $('#main').innerHTML = ({ overview, channels: channelPage, pricing: pricingPage, requests: requestPage, settings: settingsPage })[state.page]();
  document.querySelectorAll('[data-page]').forEach((b) => b.toggleAttribute('aria-current', b.dataset.page === state.page));
  document.querySelectorAll('[data-page][aria-current]').forEach((b) => b.setAttribute('aria-current', 'page'));
  if (state.page === 'pricing') updatePriceModels();
  if (animate && !reduced()) pageAnimation = $('#main').animate([{ opacity: 0.4, transform: visited.has(state.page) ? 'none' : 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: visited.has(state.page) ? 120 : 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
  visited.add(state.page);
}

function go(page) {
  if (!['overview', 'channels', 'pricing', 'requests', 'settings'].includes(page) || state.page === page) return;
  state.page = page; render(true); window.scrollTo({ top: 0 });
  if (location.hash !== `#${page}`) location.hash = page;
}

function updatePriceModels() {
  const c = channels.find((c) => c.id === $('#price-channel').value);
  $('#price-model').innerHTML = c.models.map((id) => `<option>${escape(id)}</option>`).join('');
  $('#price-model-title').textContent = c.models[0];
  $('#price-multiplier').textContent = c.rate;
  updatePriceValues();
}

function updatePriceValues() {
  const c = channels.find((c) => c.id === $('#price-channel').value);
  const sample = { 'gpt-5.6': [18, 108, 1.8, null], 'gpt-5.6-mini': [3, 18, .3, null], 'claude-opus-5': [36, 180, 3.6, 45], 'claude-sonnet-5': [18, 90, 1.8, 22.5], 'grok-4.6': [12, 60, 1.2, null], 'grok-4.5': [10, 50, 1, null], 'deepseek-v4.1-flash': [1, 2, .1, null], 'gemini-2.5-pro': [9, 72, .9, null] }[$('#price-model').value] || [null, null, null, null];
  document.querySelectorAll('.price-grid>div').forEach((node, index) => {
    const known = sample[index] !== null && Number.isFinite(parseFloat(c.rate));
    node.querySelector('strong').textContent = known ? `¥ ${Number((sample[index] * parseFloat(c.rate)).toFixed(4))}` : '未知';
  });
}

function chooseTab(tab, focus = false) {
  const e = state.editor;
  if (e?.tab) e.scroll[e.tab] = $('.editor-body').scrollTop;
  document.querySelectorAll('[data-tab]').forEach((button) => {
    const active = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    $(`#panel-${button.dataset.tab}`).hidden = !active;
    if (active && focus) button.focus();
  });
  if (e) { e.tab = tab; $('.editor-body').scrollTop = e.scroll[tab] || 0; }
}

function openEditor(id = '', tab = 'basic') {
  const channel = channels.find((c) => c.id === id);
  opener = document.activeElement;
  state.editor = { id, selected: new Set(channel?.models || []), dirty: false, saving: false, catalog: initialModels, connectionVersion: 0, scroll: {} };
  state.modelQuery = ''; state.onlySelected = false; state.modelPage = 0;
  $('#editor-title').textContent = channel ? channel.name : '新增渠道';
  $('#panel-basic').innerHTML = `<p class="section-description">名称、池、协议和管理站点分别配置。</p><div class="form-grid"><label class="full">渠道名称<input id="channel-name" name="name" required maxlength="100" value="${escape(channel?.name || '')}" placeholder="例如：OpenAI 主用" autocomplete="off"></label><label>路由池<select id="channel-pool">${pools.map((p) => `<option ${p === channel?.pool ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label>传输协议<select id="channel-protocol">${['OpenAI Responses', 'OpenAI Chat', 'Anthropic Messages'].map((p) => `<option ${p === (channel?.protocol || (channel?.pool === 'Claude' ? 'Anthropic Messages' : 'OpenAI Responses')) ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label class="full">上游地址<input id="channel-url" type="url" value="${escape(channel?.url || 'https://relay.example')}" required autocomplete="off"></label><label class="full">API Key<input id="channel-key" type="password" ${channel ? '' : 'required'} placeholder="${channel ? '已配置，留空沿用' : '填写渠道密钥'}" autocomplete="new-password" autocapitalize="none" spellcheck="false"><small>只用于本次草稿，不回填已有密钥。</small></label></div><div class="notice">新渠道保存为停用，检测后可手动启用。</div>`;
  $('#panel-models').innerHTML = `<div class="model-toolbar"><div><h3>上游模型</h3><p id="catalog-status" role="status">拉取目录不会替换已选模型</p></div><button class="button" type="button" id="fetch-models">↻ 拉取模型</button></div><div class="model-search"><input id="model-search" type="search" aria-label="搜索模型 ID" placeholder="搜索模型 ID"><label class="check-label"><input type="checkbox" id="only-selected">仅已选</label></div><div class="selection-toolbar"><button type="button" id="select-filtered" class="text-button">全选筛选结果</button><button type="button" id="deselect-filtered" class="text-button">取消筛选结果</button><strong id="selection-count" aria-live="polite"></strong></div><div id="model-list" class="model-list"></div><div class="model-pagination"><span id="model-range"></span><div><button type="button" class="button" id="model-prev" aria-label="上一页模型">←</button><button type="button" class="button" id="model-next" aria-label="下一页模型">→</button></div></div><details class="manual-models"><summary>手工补充模型</summary><label>每行一个或逗号分隔<textarea id="manual-models" rows="3" placeholder="完整模型 ID"></textarea></label><button type="button" class="button" id="add-models">加入已选</button></details><div class="form-grid routing-fields"><label>优先级<input id="channel-priority" type="number" min="0" value="${channel?.priority ?? 0}"></label><label>同层权重<input id="channel-weight" type="number" min="0" value="${channel?.weight ?? 10}"></label></div>`;
  $('#panel-billing').innerHTML = `<p class="section-description">自动读取上游采购倍率与账户余额，来源可追溯。</p><div class="billing-summary"><span>最近确认倍率</span><strong>${escape(channel?.rate || '尚未同步')}</strong><small>来源：上游分组 · 14:20 更新</small></div><div class="billing-summary"><span>上游账户余额</span><strong>${escape(channel?.balance || '尚未同步')}</strong><small>读取账户余额，不以调用令牌的无限额度替代。</small></div><label>管理站点<select><option>自动识别</option><option>New API</option><option>Sub2API</option></select></label><div class="notice">倍率或余额暂不可用时，基本配置仍可保存。</div>`;
  $('#editor-status').textContent = channel ? '修改后保存生效' : '新渠道默认停用';
  $('#save-channel').disabled = false; $('#save-channel').textContent = '保存渠道';
  renderModels(); chooseTab(tab); show($('#editor'));
}

function renderModels() {
  const e = state.editor;
  if (!e) return;
  const result = modelPage(e.catalog, e.selected, state.modelQuery, state.onlySelected, state.modelPage);
  state.modelPage = result.page;
  $('#model-list').innerHTML = result.items.length ? result.items.map((m) => `<label class="model-option"><input type="checkbox" data-model="${escape(m.id)}" ${m.selected ? 'checked' : ''}><span>${escape(m.id)}${m.missing ? '<small>上游本次未返回 · 已保留</small>' : ''}</span></label>`).join('') : '<div class="empty-state">没有匹配模型，已选模型保持不变。</div>';
  $('#selection-count').textContent = `已选 ${e.selected.size} 个`;
  $('#model-range').textContent = result.total ? `${result.page * 50 + 1}–${Math.min((result.page + 1) * 50, result.total)} / ${result.total} 个` : '0 个匹配';
  $('#model-prev').disabled = !result.page; $('#model-next').disabled = result.page === result.lastPage;
}

function requestClose() {
  if (state.editor?.saving) return;
  if (state.editor?.dirty) show($('#discard')); else dismiss($('#editor'));
}

async function saveChannel(event) {
  event.preventDefault();
  const e = state.editor;
  if (!e || e.saving) return;
  $('#channel-name').value = $('#channel-name').value.trim();
  const invalid = $('#editor-form').querySelector(':invalid');
  if (invalid) { chooseTab(invalid.closest('[role=tabpanel]').id.replace('panel-', '')); $('#editor-status').textContent = '请检查标出的字段'; $('#editor-form').reportValidity(); return; }
  if (!$('#editor-form').reportValidity()) return;
  if (!e.selected.size) { chooseTab('models'); $('#editor-status').textContent = '请至少选择一个模型'; $('#model-search').focus(); return; }
  e.saving = true; $('#save-channel').disabled = true; $('#save-channel').textContent = '保存中…'; $('#editor-status').textContent = '正在保存，请稍候';
  await new Promise((resolve) => setTimeout(resolve, 360));
  const existing = channels.find((c) => c.id === e.id);
  const values = { name: $('#channel-name').value.trim(), pool: $('#channel-pool').value, models: [...e.selected], priority: Number($('#channel-priority').value), url: $('#channel-url').value, protocol: $('#channel-protocol').value, weight: Number($('#channel-weight').value) };
  if (existing) Object.assign(existing, values);
  else channels.push({ ...values, id: crypto.randomUUID(), role: '停用', enabled: false, rate: '待同步', balance: '待同步', color: 'openai', health: '', latency: '' });
  e.dirty = false; e.saving = false;
  $('#channel-key').value = '';
  await dismiss($('#editor')); state.page = 'channels'; location.hash = 'channels'; render(); $('#main h1').focus();
  notify(existing ? '✓ 渠道修改已保存' : '✓ 已创建为停用，可检测后启用');
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.page) go(button.dataset.page);
  if (button.dataset.go) go(button.dataset.go);
  if (button.id === 'add-channel') openEditor();
  if (button.dataset.edit) openEditor(button.dataset.edit, button.dataset.editTab);
  if (button.dataset.tab) chooseTab(button.dataset.tab);
  if (button.dataset.action === 'close-editor') requestClose();
  if (button.id === 'keep-editing') dismiss($('#discard'));
  if (button.id === 'discard-changes') { state.editor.dirty = false; await dismiss($('#discard')); await dismiss($('#editor')); }
  if (button.id === 'refresh') { button.disabled = true; button.setAttribute('aria-label', '正在刷新'); const spinner = setTimeout(() => button.classList.add('busy'), 300); await new Promise((resolve) => setTimeout(resolve, 450)); clearTimeout(spinner); button.disabled = false; button.classList.remove('busy'); button.setAttribute('aria-label', '刷新当前页面'); notify('已是最新数据，当前筛选与位置已保留'); }
  if (button.dataset.distribution) { document.querySelectorAll('[data-distribution]').forEach((b) => b.setAttribute('aria-pressed', String(b === button))); $('#cost-bars').innerHTML = costBars(button.dataset.distribution === 'test'); }
  if (button.id === 'fetch-models') {
    const e = state.editor, version = e.connectionVersion, run = ++state.run;
    button.disabled = true; button.textContent = '正在拉取…';
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (e !== state.editor || !$('#editor').open || run !== state.run) return;
    button.disabled = false; button.textContent = '↻ 拉取模型';
    if (e.connectionVersion !== version) { $('#catalog-status').textContent = '连接参数已变化，请重新拉取'; return; }
    e.catalog = catalog; state.modelPage = 0; renderModels(); $('#catalog-status').textContent = '目录已更新 · 1000 个候选，已有选择保留';
  }
  if (button.id === 'select-filtered') { matchingModels(state.editor.catalog, state.editor.selected, state.modelQuery, state.onlySelected).forEach((id) => state.editor.selected.add(id)); state.editor.dirty = true; renderModels(); }
  if (button.id === 'deselect-filtered') { matchingModels(state.editor.catalog, state.editor.selected, state.modelQuery, state.onlySelected).forEach((id) => state.editor.selected.delete(id)); state.editor.dirty = true; renderModels(); }
  if (button.id === 'model-next' || button.id === 'model-prev') { state.modelPage += button.id === 'model-next' ? 1 : -1; renderModels(); }
  if (button.id === 'add-models') { parseModels($('#manual-models').value).forEach((id) => state.editor.selected.add(id)); state.editor.dirty = true; $('#manual-models').value = ''; renderModels(); }
  if (button.dataset.toggle) { const c = channels.find((c) => c.id === button.dataset.toggle); c.enabled = !c.enabled; c.role = c.enabled ? '副用' : '停用'; render(); notify(c.enabled ? '渠道已启用，自动探活将恢复' : '渠道已停用，自动探活已暂停'); }
  if (button.dataset.primary) { const c = channels.find((c) => c.id === button.dataset.primary); channels.filter((x) => x.pool === c.pool).forEach((x) => { if (x.enabled) x.role = x === c ? '主用' : '副用'; }); render(); notify(`${c.pool} 已设置唯一主用`); }
  if (button.dataset.probe) { const c = channels.find((c) => c.id === button.dataset.probe); button.disabled = true; button.textContent = '检测中…'; await new Promise((resolve) => setTimeout(resolve, 400)); button.disabled = false; button.textContent = '单次检测'; notify(`${c.name} 本次检测完成，启停状态保持`); }
  if (button.dataset.detail !== undefined) {
    const r = requests[Number(button.dataset.detail)];
    $('#detail-body').innerHTML = `<div class="detail-status"><span class="badge ${r.status === '成功' ? 'success' : 'warning'}">${escape(r.status)}</span><strong class="money">${escape(r.cost)}</strong></div><dl>${[['渠道', r.channel], ['模型', r.model], ['协议', '/v1/responses'], ['请求推理强度', r.effort || '—'], ['未缓存输入', r.input], ['缓存读取', r.read || '—'], ['缓存写入', r.write || '—'], ['输出', r.output], ['首字', '0.74 s'], ['总耗时', r.latency], ['平均输出速率', outputRate(r)], ['速率口径', '输出 Token ÷ 总耗时（含等待，输出可能含推理 Token；秒级估算）'], ['调用次数', '1 次，未重放']].map(([label, value]) => `<div><dt>${label}</dt><dd class="${['总耗时', '平均输出速率'].includes(label) ? 'latency' : label === '缓存读取' ? 'read' : label === '缓存写入' ? 'write' : ''}">${escape(value)}</dd></div>`).join('')}</dl>${r.status !== '成功' ? '<div class="notice warning-note">上游流在终止事件前中断；已知用量保留，费用为已知部分。</div>' : ''}`;
    show($('#detail'));
  }
  if (button.id === 'close-detail') dismiss($('#detail'));
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'channel-search') { state.query = event.target.value; $('#channels-body').innerHTML = channelRows(); }
  if (event.target.id === 'model-search') { state.modelQuery = event.target.value; state.modelPage = 0; renderModels(); }
  if (event.target.closest('#editor-form') && !['model-search', 'only-selected'].includes(event.target.id)) state.editor.dirty = true;
  if (['channel-url', 'channel-key', 'channel-protocol'].includes(event.target.id)) state.editor.connectionVersion++;
});
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.id === 'period') { state.period = target.value; notify(`已切换到${target.selectedOptions[0].textContent}，原型数据保持示例值`); }
  if (target.id === 'only-selected') { state.onlySelected = target.checked; state.modelPage = 0; renderModels(); }
  if (target.dataset.model) { const index = [...document.querySelectorAll('#model-list input')].indexOf(target); if (target.checked) state.editor.selected.add(target.dataset.model); else state.editor.selected.delete(target.dataset.model); state.editor.dirty = true; $('#selection-count').textContent = `已选 ${state.editor.selected.size} 个`; if (!reduced()) $('#selection-count').animate([{ opacity: .4 }, { opacity: 1 }], { duration: 160 }); if (state.onlySelected) { renderModels(); const inputs = [...document.querySelectorAll('#model-list input')]; (inputs[Math.min(index, inputs.length - 1)] || $('#model-search')).focus(); } }
  if (target.id === 'request-filter') $('#request-body').innerHTML = requestRows(target.value);
  if (target.id === 'price-channel') updatePriceModels();
  if (target.id === 'price-model') { $('#price-model-title').textContent = target.value; updatePriceValues(); }
  if (target.id === 'reduce-motion') { document.documentElement.dataset.motion = target.checked ? 'reduce' : 'normal'; if (target.checked) pageAnimation?.cancel(); }
  if (target.id === 'trend-channel') { $('#trend-rate').innerHTML = `${target.selectedIndex ? '96.2' : '94.8'}<small>%</small>`; }
});
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-pool]');
  if (button) { state.pool = button.dataset.pool; document.querySelectorAll('[data-pool]').forEach((b) => b.setAttribute('aria-pressed', String(b === button))); $('#channels-body').innerHTML = channelRows(); }
});
$('#editor-form').addEventListener('submit', saveChannel);
$('#editor-form').addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.matches('input')) event.preventDefault(); });
$('#editor').addEventListener('cancel', (event) => { event.preventDefault(); requestClose(); });
$('#editor').addEventListener('close', () => { state.run++; state.editor = null; $('#channel-key').value = ''; if (opener?.isConnected) opener.focus(); else $('#main h1')?.focus(); });
$('#detail').addEventListener('cancel', (event) => { event.preventDefault(); dismiss($('#detail')); });
$('.editor-tabs').addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const tabs = ['basic', 'models', 'billing']; const active = document.activeElement.dataset.tab; let index = tabs.indexOf(active); index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3; chooseTab(tabs[index], true); });
document.addEventListener('submit', (event) => { if (event.target.id !== 'probe-settings') return; event.preventDefault(); if (!event.target.reportValidity()) return; state.interval = Number($('#probe-interval').value); notify(`探活间隔已保存：${state.interval} 分钟`); });
document.addEventListener('visibilitychange', () => document.documentElement.classList.toggle('page-hidden', document.hidden));
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
if (['overview', 'channels', 'pricing', 'requests', 'settings'].includes(location.hash.slice(1))) state.page = location.hash.slice(1);
if (window.visualViewport) {
  const viewport = window.visualViewport;
  let baseline = { width: viewport.width, height: Math.max(window.innerHeight, viewport.height) };
  const syncViewport = () => {
    const editing = document.activeElement.matches('input,textarea,select');
    if (!editing || Math.abs(viewport.width - baseline.width) > 40) baseline = { width: viewport.width, height: Math.max(window.innerHeight, viewport.height) };
    const keyboard = matchMedia('(pointer:coarse)').matches && editing && baseline.height - viewport.height > 150;
    document.documentElement.classList.toggle('kb-open', keyboard);
    if (keyboard && $('#editor').open) { $('#editor').style.height = `${viewport.height}px`; $('#editor').style.top = `${viewport.offsetTop}px`; document.activeElement.scrollIntoView({ block: 'nearest' }); }
    else { $('#editor').style.removeProperty('height'); $('#editor').style.removeProperty('top'); }
  };
  viewport.addEventListener('resize', syncViewport);
  viewport.addEventListener('scroll', syncViewport);
  document.addEventListener('focusin', syncViewport);
}
render();
