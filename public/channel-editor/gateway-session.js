import { createEditorDraft, setConnection, setCredential, setSelectedModels, beginDiscovery, finishDiscovery,
  isCurrentDiscovery, beginSave, finishSave, closeEditorDraft, conflictMessage, modelVendorId } from './state.js';

export function createGatewaySession({ config, channel = null, api, onChange = () => {}, onSaved = () => {} }) {
  const mappings = new Map((channel?.models || []).map((model) => [model.modelId, structuredClone(model)]));
  const vendors = new Map((config.models || []).map((model) => [model.id, model.vendor]));
  let current = createEditorDraft(channel ? { ...channel, models: channel.models.map((model) => model.modelId),
    protocol: channel.models[0]?.capabilities[0] || '' } : null);
  current = { ...current, poolId: current.poolId || config.pools[0]?.id || '', protocol: current.protocol || 'responses',
    vendor: '', baseGen: config.gen, newPools: [], protocolChanged: false, error: '', initial: null, result: null };
  // 「传输协议」下拉框的初值（第一个模型的第一个能力）只是"用户没动过"的参照，不代表整条渠道。
  // 能力只有在用户把下拉框改成别的值时才被它覆盖；否则：已有模型保持原能力，新增或改名的模型取本渠道原有模型能力的并集，
  // 渠道里原来没有任何模型（新建）时才用下拉框的值。并集按原有模型算而不是按当前勾选算，整批改名也不会丢能力。
  const initialProtocol = current.protocol;
  const savedCapabilities = new Map((channel?.models || []).map((model) => [model.modelId, [...model.capabilities]]));
  const inheritedCapabilities = [...new Set((channel?.models || []).flatMap((model) => model.capabilities))];
  const capabilitiesFor = (modelId) => current.protocolChanged ? [current.protocol]
    : savedCapabilities.has(modelId) ? [...savedCapabilities.get(modelId)]
      : inheritedCapabilities.length ? [...inheritedCapabilities] : [current.protocol];
  if (!current.poolIds.length && current.poolId) current.poolIds = [current.poolId];
  const pools = () => [...config.pools, ...current.newPools];
  const serializable = () => ({ name: current.name, poolId: current.poolId, poolIds: current.poolIds, newPools: current.newPools, poolPriorities: current.poolPriorities, baseUrl: current.baseUrl,
    protocol: current.protocol, protocolChanged: current.protocolChanged, adapter: current.adapter, vendor: current.vendor,
    selected: current.selected, testModel: current.testModel, priority: current.priority, weight: current.weight,
    enabled: current.enabled, credentialAction: current.credentialAction, credentialValue: current.credentialValue });
  current.initial = JSON.stringify(serializable());
  const update = (value) => { current = value; onChange(current); return current; };
  const active = (sessionId) => !current.closed && current.sessionId === sessionId;

  function command() {
    if (!current.name.trim() || !current.baseUrl.trim() || !current.poolId || !current.selected.length) throw new Error('请填写名称、分组、上游地址并选择模型');
    if (!current.poolIds.length || !current.poolIds.includes(current.poolId) || current.poolIds.some((id) => !pools().some((pool) => pool.id === id))) throw new Error('请至少选择一个有效所属分组，并保留主分组');
    const newPools = current.newPools.filter((pool) => current.poolIds.includes(pool.id));
    const poolPriorities = Object.fromEntries(current.poolIds.map((id) => [id, current.poolPriorities[id] ?? current.priority]));
    if (!Object.values(poolPriorities).every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647)) throw new Error('分组优先级超出有效范围');
    let url;
    try { url = new URL(current.baseUrl); } catch { throw new Error('请填写有效的上游 HTTP 地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('请填写有效的上游 HTTP 地址');
    if (![current.priority, current.weight].every(Number.isSafeInteger) || current.priority < 0 || current.priority > 2147483647 || current.weight < 0 || current.weight > 1000000) throw new Error('优先级或权重超出有效范围');
    if (!current.credentialConfirmed) throw new Error('请确认是否将已有凭据用于当前上游地址');
    if (current.credentialAction === 'replace' && !current.credentialValue) throw new Error('请填写 API Key');
    if (current.credentialAction === 'clear' && current.enabled) throw new Error('清除凭据前请先停用渠道');
    // 检测模型留空时与后端探活一致：默认用第一个已选模型；只有用户自己选的检测模型不在已选列表里才报错。
    const testModel = current.testModel || current.selected[0];
    if (!current.selected.includes(testModel)) throw new Error('请从已选模型中明确选择检测模型');
    const models = current.selected.map((modelId) => {
      const previous = mappings.get(modelId), vendor = modelVendorId(modelId, vendors) || current.vendor.trim();
      if (!vendor) throw new Error(`未识别模型厂商，请在“自定义模型厂商”填写厂商标识：${modelId}`);
      return { modelId, upstreamModel: previous?.upstreamModel || modelId, capabilities: capabilitiesFor(modelId), vendor };
    });
    return { baseGen: current.baseGen, operationId: current.operationId, change: {
      action: current.channelId ? 'update' : 'create', ...(current.channelId ? { channelId: current.channelId } : {}),
      ...(newPools.length ? { newPools } : {}),
      channel: { name: current.name.trim(), poolId: current.poolId, poolIds: [...current.poolIds], poolPriorities, baseUrl: current.baseUrl.trim(), models,
        ...(current.adapter || channel?.adapter ? { adapter: current.adapter } : {}),
        priority: current.priority, weight: current.weight, enabled: current.channelId ? current.enabled : false, testModel },
      credentialAction: current.credentialAction,
      ...(current.credentialAction === 'keep' && current.credentialConfirmed ? { confirmRetainedCredential: true } : {}),
      ...(current.credentialAction === 'replace' ? { credentialValue: current.credentialValue } : {}) } };
  }

  function discoveryBlock() {
    if (current.credentialAction === 'clear') return '清除凭据的草稿不能拉取模型';
    if (!current.baseUrl || !current.credentialConfirmed || (current.credentialAction === 'replace' && !current.credentialValue)) return '请填写地址和凭据，并确认沿用凭据的目标';
    return '';
  }

  async function acceptResult(result, sessionId) {
    if (!active(sessionId)) return result;
    const status = result.activated === true && result.servingGen === result.desiredGen && result.committedGen === result.desiredGen ? 'active' : 'pending';
    update({ ...finishSave(current, status), result, error: '' });
    await onSaved(result);
    return result;
  }

  return {
    get draft() { return current; },
    get pools() { return pools(); },
    // 每个已选模型保存时会写入的能力，和 command() 用同一个函数，界面只读展示。
    get capabilities() { return current.selected.map((modelId) => ({ modelId, capabilities: capabilitiesFor(modelId) })); },
    get dirty() { return !current.closed && JSON.stringify(serializable()) !== current.initial; },
    get summary() {
      const before = JSON.parse(current.initial), now = serializable();
      const labels = { name: '名称', poolId: '主分组', poolIds: '所属分组', newPools: '新增分组', poolPriorities: '各分组优先级', baseUrl: '上游地址', protocol: '传输协议', adapter: '上游适配器', vendor: '新增模型厂商',
        selected: '模型选择', testModel: '检测模型', priority: '优先级', weight: '权重', enabled: '启停状态' };
      const changed = Object.entries(labels).filter(([key]) => JSON.stringify(before[key]) !== JSON.stringify(now[key])).map(([, label]) => label);
      if (current.credentialAction === 'replace' && current.credentialValue) changed.push('替换凭据');
      if (current.credentialAction === 'clear') changed.push('清除凭据');
      return current.channelId ? changed.length ? `将修改：${changed.join('、')}` : '尚无配置变更' : `将创建停用渠道 · 已选 ${current.selected.length} 个模型`;
    },
    command,
    addPool(value) {
      if (current.closed || current.saving || ['pending', 'unknown', 'active'].includes(current.saveStatus)) return false;
      const name = value.trim();
      if (!name || name.length > 120) { update({ ...current, error: '请填写 1–120 个字符的分组名称' }); return false; }
      if (pools().some((pool) => pool.name.toLowerCase() === name.toLowerCase())) {
        update({ ...current, error: '此分组已存在，请直接勾选' }); return false;
      }
      const pool = { id: `group-${current.sessionId}-${current.newPools.length + 1}`, name };
      update({ ...current, newPools: [...current.newPools, pool], poolIds: [...current.poolIds, pool.id], poolId: current.poolId || pool.id, error: '' });
      return true;
    },
    edit(patch) {
      if (current.closed || current.saving || ['pending', 'unknown'].includes(current.saveStatus)) return;
      // 只表示"下拉框现在的值和打开时不同"；选回原值就不再算改过（原来一旦置位就不会复位，会把所有模型压成单协议）。
      const protocolChanged = 'protocol' in patch ? patch.protocol !== initialProtocol : current.protocolChanged;
      let next = setConnection(current, patch);
      next = { ...next, ...patch, protocolChanged, error: '' };
      update(next);
    },
    credential(action, value = '', confirmRetained = false) {
      if (current.closed || current.saving || ['pending', 'unknown'].includes(current.saveStatus)) return;
      const next = setCredential(current, action, value);
      if (action === 'keep' && channel && (current.baseUrl !== channel.baseUrl || current.protocolChanged || current.adapter !== (channel.adapter || '')) && !confirmRetained) next.credentialConfirmed = false;
      update({ ...next, error: '' });
    },
    select(values) {
      if (current.closed || current.saving || ['pending', 'unknown'].includes(current.saveStatus)) return;
      update(setSelectedModels(current, values));
    },
    replaceDraft(next) {
      if (!current.closed && !current.saving && !['pending', 'unknown'].includes(current.saveStatus)) update(next);
    },
    // 拉取前的凭据确认关：返回空串表示可以拉取，否则是要展示给用户的原因。弹窗入口和 discover() 共用。
    get discoveryBlock() { return discoveryBlock(); },
    async discover() {
      if (current.closed || current.discoveryStatus === 'loading' || current.saving) return;
      const blocked = discoveryBlock();
      if (blocked) { update({ ...current, error: blocked }); return; }
      const started = beginDiscovery(current); update(started.draft);
      const body = { baseGen: current.baseGen, ...(current.channelId ? { channelId: current.channelId } : {}),
        baseUrl: current.baseUrl, capabilities: [current.protocol], credentialAction: current.credentialAction,
        ...(current.adapter || channel?.adapter ? { adapter: current.adapter } : {}),
        ...(current.credentialAction === 'replace' ? { credentialValue: current.credentialValue } : {}),
        ...(current.credentialAction === 'keep' && current.credentialConfirmed ? { confirmRetainedCredential: true } : {}) };
      try {
        const result = await api('/api/gateway/models/preview', { method: 'POST', body: JSON.stringify(body) });
        if (!isCurrentDiscovery(current, started.token)) return;
        for (const model of result.models) if (!mappings.has(model.id)) mappings.set(model.id, {
          modelId: model.id, upstreamModel: model.id, capabilities: [...model.capabilities] });
        update(finishDiscovery(current, started.token, { models: result.models.map((model) => model.id), observedAt: result.observedAt }));
      } catch (error) {
        if (isCurrentDiscovery(current, started.token)) update(finishDiscovery(current, started.token, { error: error.message }));
      }
    },
    async save() {
      if (current.closed || current.saving || current.saveStatus === 'pending' || current.saveStatus === 'active') return;
      let payload;
      try { payload = command(); } catch (error) { update({ ...current, error: error.message }); return; }
      const sessionId = current.sessionId;
      update({ ...beginSave(current), error: '' });
      try { return await acceptResult(await api('/api/gateway/channels/change', { method: 'POST', body: JSON.stringify(payload) }), sessionId); }
      catch (error) {
        if (!active(sessionId)) return;
        const status = error.status ? 'failed' : 'unknown';
        update({ ...finishSave(current, status), error: conflictMessage(error, '配置已变化，请关闭后重新打开；草稿仍保留供核对') });
      }
    },
    async reconcile() {
      if (current.closed || current.saving || !['pending', 'unknown'].includes(current.saveStatus)) return;
      const sessionId = current.sessionId;
      update({ ...beginSave(current), error: '' });
      try { return await acceptResult(await api('/api/gateway/reconcile', { method: 'POST' }), sessionId); }
      catch (error) { if (active(sessionId)) update({ ...finishSave(current, 'unknown'), error: error.message }); }
    },
    close() { update(closeEditorDraft(current)); },
  };
}
