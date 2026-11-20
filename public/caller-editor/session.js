import { createEditorDraft, conflictMessage } from '../channel-editor/state.js';

const copy = (value) => structuredClone(value);
// A permission whose modelIds is exactly ["*"] names every model the listed channels offer (backend contract).
export const WILDCARD_MODEL = '*';
// channelIds, modelIds and protocols may each be exactly ["*"]; a mixed list such as ["*", "x"] is not a wildcard.
const isWildcard = (items) => items.length === 1 && items[0] === WILDCARD_MODEL;
const permission = (row, wildcard = false) => ({ poolId: row.poolId, modelIds: wildcard ? [WILDCARD_MODEL] : [...row.modelIds],
  channelIds: [...row.channelIds], protocols: [...row.protocols], groups: [...row.groups] });
// A group grant ("可用分组"): every channel, model and protocol of one pool, no legacy group restriction.
export const groupGrant = (poolId) => ({ poolId, channelIds: [WILDCARD_MODEL], modelIds: [WILDCARD_MODEL], protocols: [WILDCARD_MODEL], groups: [] });
export const isGroupGrant = (row) => isWildcard(row.channelIds) && isWildcard(row.modelIds) && isWildcard(row.protocols) && row.groups.length === 0;
// Pool ids named by any permission of the caller (first-seen order, no duplicates).
export const grantedPoolIds = (permissions) => [...new Set(permissions.map((row) => row.poolId))];

// wildcardModels: permissions are written as ["*"] (all models of the listed channels); the model list is not edited per row.
export function createCallerSession({ config, caller = null, api, wildcardModels = false, onChange = () => {}, onSaved = () => {} }) {
  let current = { operationId: createEditorDraft().operationId, baseGen: config.gen, callerId: caller?.id ?? null,
    name: caller?.name ?? '', enabled: caller?.enabled ?? false, subjectEnabled: caller?.subjectEnabled ?? true,
    expiresAt: caller?.expiresAt ?? null, allowedIps: [...(caller?.allowedIps || [])],
    permissions: (caller?.permissions || []).map(permission), status: 'idle', saving: false, error: '', oneTimeToken: '', tokenUnavailable: false, closed: false };
  const data = () => ({ name: current.name.trim(), enabled: current.enabled, subjectEnabled: current.subjectEnabled,
    expiresAt: current.expiresAt || null, allowedIps: [...current.allowedIps], permissions: current.permissions.map((row) => permission(row, wildcardModels)) });
  const initial = JSON.stringify(data());
  const update = (patch) => { current = { ...current, ...patch }; onChange(current); };
  let submitted = null;
  const validate = () => {
    if (!current.name.trim() || current.name.trim().length > 120) throw new Error('请填写 1 到 120 字的密钥名称');
    if (current.expiresAt !== null && (!Number.isFinite(Date.parse(current.expiresAt)) || !/Z$/.test(current.expiresAt))) throw new Error('到期时间须为 UTC 时间（以 Z 结尾）');
    for (const row of current.permissions.map((item) => permission(item, wildcardModels))) {
      if (!config.pools.some((pool) => pool.id === row.poolId)) throw new Error('请选择有效的权限分组');
      if (![row.modelIds, row.channelIds, row.protocols].every((items) => items.length > 0 && new Set(items).size === items.length)) throw new Error(wildcardModels ? '每条权限须明确选择渠道和协议' : '每条权限须明确选择模型、渠道和协议');
      if (!isWildcard(row.channelIds) && row.channelIds.some((id) => !config.channels.some((channel) => channel.id === id && (channel.poolIds ?? [channel.poolId]).includes(row.poolId)))) throw new Error('所选渠道须属于该分组');
      if (!isWildcard(row.modelIds) && row.modelIds.some((id) => !config.models.some((model) => model.id === id))) throw new Error('权限包含未知模型');
      if (!isWildcard(row.protocols) && row.protocols.some((protocol) => !['responses', 'chat_completions', 'messages', 'gemini_generate_content', 'count_tokens'].includes(protocol))) throw new Error('权限包含未知协议');
    }
  };
  async function accept(result) {
    if (current.closed) return;
    // Never pass token plaintext to the app-level config/status state.
    const { oneTimeToken, ...receipt } = result;
    update({ saving: false, error: '', ...(wildcardModels ? { permissions: current.permissions.map((row) => permission(row, true)) } : {}), status: result.activated === true && result.desiredGen === result.committedGen && result.desiredGen === result.servingGen ? 'active' : 'pending',
      tokenUnavailable: result.oneTimeTokenUnavailable === true && !current.oneTimeToken,
      oneTimeToken: typeof oneTimeToken === 'string' ? oneTimeToken : current.oneTimeToken });
    await onSaved(receipt);
  }
  return {
    get draft() { return current; },
    get dirty() { return !current.closed && initial !== JSON.stringify(data()); },
    edit(patch) {
      if (current.closed || current.saving || ['pending', 'unknown', 'active'].includes(current.status)) return;
      const editable = Object.fromEntries(Object.entries(patch).filter(([key]) => ['name', 'enabled', 'subjectEnabled', 'expiresAt', 'allowedIps', 'permissions'].includes(key)));
      update({ ...copy(editable), error: '' });
    },
    async save(action = current.callerId ? 'update' : 'create') {
      if (current.closed || current.saving || ['pending', 'active'].includes(current.status)) return;
      if (!submitted || current.status !== 'unknown') {
        try {
          if (!['create', 'update', 'enable', 'disable', 'rotate'].includes(action) || (action !== 'create' && !current.callerId)) throw new Error('密钥操作无效');
          if (action === 'create' || action === 'update') validate();
          submitted = { baseGen: current.baseGen, operationId: current.operationId, change: { action,
            ...(current.callerId ? { callerId: current.callerId } : {}),
            ...(['create', 'update'].includes(action) ? { caller: { ...data(), enabled: current.callerId ? current.enabled : false } } : {}) } };
        } catch (error) { update({ error: error.message }); return; }
      }
      update({ saving: true, error: '' });
      try { await accept(await api('/api/gateway/callers/change', { method: 'POST', body: JSON.stringify(submitted) })); }
      catch (error) { if (!current.closed) update({ saving: false, status: error.status ? 'failed' : 'unknown',
        error: conflictMessage(error, '配置已变化，请核对草稿后重新打开') }); }
    },
    async reconcile() {
      if (current.closed || current.saving || current.status !== 'pending') return;
      update({ saving: true, error: '' });
      try { await accept(await api('/api/gateway/reconcile', { method: 'POST' })); }
      catch (error) { if (!current.closed) update({ saving: false, status: 'pending', error: error.message }); }
    },
    clearToken() { update({ oneTimeToken: '' }); },
    close() { current = { ...current, oneTimeToken: '', closed: true }; submitted = null; onChange(current); },
  };
}
