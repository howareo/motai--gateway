import { createGatewaySession } from './gateway-session.js';
import { mountModelPicker } from './model-picker.js';
import { modelVendorId } from './state.js';

export function openGatewayEditor({ dialog, template, config, channel, api, onSaved, notify = () => {}, trigger, tab = 'basic', mountBilling, onSession = () => {}, created = false }) {
  dialog.replaceChildren(template.content.cloneNode(true));
  const $ = (selector) => dialog.querySelector(selector);
  const form = $('form');
  const vendors = new Map((config.models || []).map((model) => [model.id, model.vendor]));
  let session;
  let initial = true;
  let previousSaveStatus;
  let latestConfig, createdChannelId, previousSelected, previousDiscovered, previousTestModel, previousProtocol, previousVendor;
  const setActiveNav = (value) => {
    for (const button of dialog.querySelectorAll('[data-editor-jump]')) {
      const active = button.dataset.editorJump === value;
      button.classList?.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'true');
      else button.removeAttribute?.('aria-current');
    }
  };
  const showSection = (value, focus = true) => {
    const target = $('[data-editor-panel="' + value + '"]') ? value : 'basic';
    const panel = $('[data-editor-panel="' + target + '"]');
    setActiveNav(target);
    if (target === 'advanced') $('[data-editor-advanced]').open = true;
    const body = $('.gateway-editor-body');
    body.scrollTop = Math.max(0, body.scrollTop + panel.getBoundingClientRect().top - body.getBoundingClientRect().top - 12);
    if (focus) (panel.querySelector('h3') || panel.querySelector('summary'))?.focus({ preventScroll: true });
  };
  const option = (select, value, label) => { const item = document.createElement('option'); item.value = value; item.textContent = label; select.append(item); };
  const renderTestModels = () => {
    const select = $('[name="testModel"]'); select.replaceChildren();
    option(select, '', session.draft.selected.length ? '默认：' + session.draft.selected[0] + '（首个已选）' : '先选择模型');
    for (const id of session.draft.selected) option(select, id, id);
    select.value = session.draft.testModel;
    select.disabled = session.draft.selected.length === 0;
  };
  const renderPools = (draft) => {
    const existing = new Set([...$('[data-editor-pools]').querySelectorAll('input')].map((input) => input.value));
    for (const pool of session.pools) {
      if (existing.has(pool.id)) continue;
      option($('[name="poolId"]'), pool.id, pool.name);
      const label = document.createElement('label'), input = document.createElement('input');
      label.className = 'gateway-enabled'; input.type = 'checkbox'; input.value = pool.id;
      input.setAttribute('aria-label', pool.name); const name = document.createElement('span'); name.textContent = pool.name; label.append(input, name);
      input.addEventListener('change', () => {
        const selected = input.checked ? [...session.draft.poolIds, pool.id] : session.draft.poolIds.filter((id) => id !== pool.id);
        session.edit({ poolIds: selected, poolId: selected.includes(session.draft.poolId) ? session.draft.poolId : selected[0] || '' });
      });
      $('[data-editor-pools]').append(label);
    }
    for (const input of $('[data-editor-pools]').querySelectorAll('input')) input.checked = draft.poolIds.includes(input.value);
    $('[name="poolId"]').value = draft.poolId;
    for (const item of $('[name="poolId"]').querySelectorAll('option')) item.disabled = !draft.poolIds.includes(item.value);
  };
  // 每个已选模型保存时会写入的协议能力（只读），数据来自会话里和保存命令同一个函数。
  const renderCapabilities = () => {
    const box = $('[data-editor-capabilities]'), rows = session.capabilities;
    box.hidden = rows.length === 0; box.replaceChildren();
    for (const { modelId, capabilities } of rows) {
      const row = document.createElement('div'); row.className = 'model-capability-row'; row.setAttribute('role', 'listitem');
      row.setAttribute('data-capability-model', modelId); row.setAttribute('data-capability-values', capabilities.join(','));
      const name = document.createElement('span'); name.className = 'model-picker-id'; name.textContent = modelId; name.title = modelId;
      row.append(name);
      for (const capability of capabilities) { const chip = document.createElement('small'); chip.className = 'capability-chip'; chip.textContent = capability; row.append(chip); }
      box.append(row);
    }
  };
  const selectedSummary = (ids) => ids.length ? `已选 ${ids.length} 个模型：${ids.slice(0, 3).join('、')}${ids.length > 3 ? ' 等' : ''}` : '尚未选择模型';
  const render = (draft) => {
    if (draft.closed) return;
    const locked = draft.saving || ['pending', 'unknown', 'active'].includes(draft.saveStatus);
    for (const fieldset of dialog.querySelectorAll('fieldset')) fieldset.disabled = locked;
    $('[data-editor-save]').disabled = draft.saving || ['pending', 'active'].includes(draft.saveStatus);
    $('[data-editor-save]').textContent = draft.saving ? '保存中' : draft.saveStatus === 'unknown' ? '核对并重试同一操作' : channel ? '保存修改' : '保存渠道';
    $('[data-editor-reconcile]').hidden = draft.saveStatus !== 'pending';
    $('[data-editor-reconcile]').disabled = draft.saving;
    $('[data-editor-error]').textContent = draft.error || draft.discoveryError;
    $('[data-editor-changes]').textContent = session.summary;
    $('[data-editor-result]').textContent = draft.saveStatus === 'active' ? '已生效' : draft.saveStatus === 'pending'
      ? '已保存，等待生效；当前仍使用原配置。' : draft.saveStatus === 'unknown' ? '保存结果尚待核对；重试会沿用同一操作，避免重复创建。' : draft.saving ? '正在保存' : '';
    $('[data-editor-selected-summary]').textContent = selectedSummary(draft.selected);
    const selectionChanged = draft.selected !== previousSelected;
    if (selectionChanged || draft.protocol !== previousProtocol) renderCapabilities();
    const unknown = draft.selected.filter((id) => !modelVendorId(id, vendors));
    $('[data-editor-vendor-note]').textContent = unknown.length && !draft.vendor.trim() ? '以下模型未识别厂商，请在高级设置中补充：' + unknown.join('、') : '';
    if (unknown.length && !draft.vendor.trim() && (selectionChanged || draft.vendor !== previousVendor)) $('[data-editor-advanced]').open = true;
    $('[data-editor-protocol-note]').textContent = draft.protocolChanged
      ? `保存后，全部 ${draft.selected.length} 个已选模型的接口将改为 ${draft.protocol}。` : '';
    $('[data-editor-fetch]').disabled = locked || draft.discoveryStatus === 'loading';
    $('[data-editor-fetch-status]').textContent = draft.discoveryStatus === 'loading' ? `正在拉取 ${draft.baseUrl}`
      : draft.discoveryError || (draft.observedAt ? `目录 ${draft.discovered.length} 个 · ${draft.observedAt}` : session.discoveryBlock || '填写连接后拉取目录，勾选并保存后生效');
    $('[data-editor-confirm-key]').hidden = draft.credentialAction !== 'keep' || draft.credentialConfirmed;
    $('[data-editor-key-mode]').textContent = !channel
      ? (draft.credentialValue ? '已填写临时凭据，保存后生效（不回显）' : '请填写上游 API Key（仅本次提交，保存后不回显）')
      : draft.credentialAction === 'clear' ? '保存时清除凭据'
      : draft.credentialAction === 'replace' ? '保存时替换凭据'
      : channel?.hasCredential ? '已配置，留空沿用' : '尚未配置凭据';
    const keyNote = $('[data-editor-key-note]');
    if (keyNote) keyNote.hidden = !channel;
    renderPools(draft);
    if (!initial) {
      if (document.activeElement !== $('[name="modelsText"]')) $('[name="modelsText"]').value = draft.selected.join(', ');
      if (selectionChanged || draft.testModel !== previousTestModel) renderTestModels();
      if (selectionChanged || draft.discovered !== previousDiscovered) picker.render();
    }
    if (previousTestModel && !draft.selected.includes(previousTestModel)) $('[data-editor-probe-note]').textContent = '原探活模型已移除，已回到首个已选模型。';
    else if (draft.testModel) $('[data-editor-probe-note]').textContent = '';
    previousSelected = draft.selected; previousDiscovered = draft.discovered; previousTestModel = draft.testModel;
    previousProtocol = draft.protocol; previousVendor = draft.vendor;
    if (draft.saveStatus === 'active' && previousSaveStatus !== 'active') $('[data-editor-result]').focus({ preventScroll: true });
    previousSaveStatus = draft.saveStatus;
  };
  session = createGatewaySession({ config, channel, api, onChange: render, onSaved: async (result) => {
    createdChannelId ||= result.channelId;
    const savedConfig = await onSaved?.(result);
    latestConfig = result.config || savedConfig || latestConfig;
  } });
  const picker = mountModelPicker($('[data-editor-picker]'), { getDraft: () => session.draft, setDraft: (next) => session.replaceDraft(next) });
  $('[data-editor-title]').textContent = channel ? `编辑 ${channel.name}${created ? ' · 已保存（停用）' : ''}` : '新增渠道';
  $('[data-editor-summary]').textContent = channel ? '修改草稿，保存前核对实际变更。' : '在这一页完成连接、模型与探活设置。新渠道保存后保持停用。';
  if (created) {
    $('[data-editor-summary]').textContent = '渠道已创建，可继续设置价格与余额，或启用后保存修改。';
    for (const button of dialog.querySelectorAll('[data-editor-close]')) if (button.textContent !== '×') button.textContent = '完成';
  }
  $('[data-editor-add-pool]').addEventListener('click', () => {
    if (session.addPool($('[name="newPoolName"]').value)) $('[name="newPoolName"]').value = '';
    $('[name="newPoolName"]').focus({ preventScroll: true });
  });
  for (const name of ['name', 'poolId', 'baseUrl', 'protocol', 'adapter', 'vendor']) $('[name="' + name + '"]').value = session.draft[name];
  $('[name="enabled"]').checked = session.draft.enabled;
  $('[name="enabled"]').disabled = !channel;
  $('[data-editor-enabled]').hidden = !channel;
  $('[data-editor-clear-key]').hidden = !channel;
  $('[name="modelsText"]').value = session.draft.selected.join(', ');
  $('[name="credentialValue"]').placeholder = channel?.hasCredential ? '已配置，留空沿用；输入新值即替换' : '填写 API Key，仅保留于本次草稿';
  renderTestModels();
  const billing = $('[data-editor-billing]');
  const billingView = mountBilling?.(billing, channel?.id ?? null);
  if (!billingView) billing.textContent = channel ? '价格与余额数据尚未就绪，请刷新后重试。' : '先保存渠道，再配置成本与账户余额。';
  session.refreshBilling = () => { if (!session.draft.closed) billingView?.refresh(); };
  for (const name of ['name', 'poolId', 'baseUrl', 'protocol', 'adapter', 'vendor', 'enabled', 'testModel']) {
    const input = $('[name="' + name + '"]');
    input.addEventListener(input.tagName === 'SELECT' || input.type === 'checkbox' ? 'change' : 'input', () => {
      session.edit({ [name]: input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value });
    });
  }
  $('[name="credentialValue"]').addEventListener('input', (event) => session.credential(event.target.value ? 'replace' : channel ? 'keep' : 'replace', event.target.value));
  $('[data-editor-clear-key]').addEventListener('click', () => {
    if (session.draft.enabled) { $('[data-editor-error]').textContent = '清除凭据前请先停用渠道'; return; }
    if (window.confirm('保存时清除此渠道的调用凭据？渠道将保持停用。')) {
      $('[name="credentialValue"]').value = ''; session.credential('clear');
    }
  });
  $('[data-editor-confirm-key]').addEventListener('click', () => {
    if (window.confirm(`确认将此渠道已保存的凭据发送到当前上游 ${session.draft.baseUrl}？`)) session.credential('keep', '', true);
  });
  $('[name="modelsText"]').addEventListener('input', (event) => session.select(event.target.value));
  $('[data-editor-fetch]').addEventListener('click', () => session.discover());
  $('[data-editor-reconcile]').addEventListener('click', async () => { await session.reconcile(); await settle(); });
  const dismiss = () => { session.close(); $('[name="credentialValue"]').value = ''; dialog.close(); };
  // 新建生效后用服务端返回的 ID 续编；pending/unknown 不创建第二个渠道。
  const settle = async () => {
    const { closed, saveStatus, result } = session.draft;
    if (closed || saveStatus !== 'active') return;
    if (!channel) {
      try {
        const savedConfig = latestConfig || (await api('/api/gateway/config')).config;
        const savedChannel = savedConfig.channels.find((item) => item.id === createdChannelId);
        if (!savedChannel) throw new Error('渠道已保存，但配置尚未就绪，请刷新后继续设置。');
        session.close(); $('[name="credentialValue"]').value = '';
        openGatewayEditor({ dialog, template, config: savedConfig, channel: savedChannel, api, onSaved, notify, trigger,
          tab: 'billing', mountBilling, onSession, created: true });
      } catch (error) {
        $('[data-editor-error]').textContent = error.message;
        $('[data-editor-save]').disabled = false; $('[data-editor-save]').textContent = '继续配置';
        return;
      }
    } else dismiss();
    notify(`已保存 · gen ${result?.servingGen ?? result?.desiredGen}`);
  };
  const close = () => {
    if (session.draft.saving) { $('[data-editor-error]').textContent = '正在保存，请等待结果后关闭'; return; }
    if (session.draft.saveStatus === 'unknown' && !window.confirm('保存结果尚待核对，关闭后请先核对配置再创建，避免重复操作。仍要关闭？')) return;
    if (session.dirty && session.draft.saveStatus !== 'active' && session.draft.saveStatus !== 'pending' && session.draft.saveStatus !== 'unknown'
      && !window.confirm('放弃未保存的渠道草稿？')) return;
    dismiss();
  };
  for (const button of dialog.querySelectorAll('[data-editor-close]')) button.addEventListener('click', close);
  dialog.oncancel = (event) => { event.preventDefault(); close(); };
  dialog.onclose = () => { session.close(); dialog.replaceChildren(); if (trigger?.isConnected) trigger.focus(); };
  for (const button of dialog.querySelectorAll('[data-editor-jump]')) button.addEventListener('click', () => showSection(button.dataset.editorJump));
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing && event.target.tagName === 'INPUT') event.preventDefault();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const invalid = form.querySelector(':invalid');
    if (invalid) { const details = invalid.closest('details'); if (details) details.open = true; showSection(invalid.closest('[data-editor-panel]')?.dataset.editorPanel || 'basic', false); invalid.reportValidity(); return; }
    await session.save();
    await settle();
  });
  initial = false; render(session.draft);
  if (!dialog.open) dialog.showModal();
  showSection(tab, tab !== 'basic');
  onSession(session);
  return session;
}
