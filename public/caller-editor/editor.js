import { createCallerSession, groupGrant, isGroupGrant, grantedPoolIds } from './session.js';
import { closeOnBackdrop } from '../channel-editor/model-picker.js';
import { copyText } from './clipboard.js';

// Native controls use the existing console palette and inherit mobile dialog rules.
// refreshConfig() reloads the gateway config after a stored key changed, so the row can switch between copy and import.
export function mountCallerManager({ root, getConfig, api, onSaved, notify = () => {}, refreshConfig = async () => {} }) {
  const document = root.ownerDocument;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const button = (text, action, className = 'button button-secondary') => {
    const node = make('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const dialog = make('dialog', '', 'gateway-channel-dialog');
  const list = make('div', '', 'caller-list');
  const status = make('p', '', 'form-status'); status.setAttribute('role', 'status');
  const title = make('h2', 'API 密钥');
  const create = button('＋ 新增 API 密钥', () => openEditor(null, create), 'button button-primary');
  const titleBox = make('div'); titleBox.append(title, make('p', '管理客户端使用的密钥，以及每把密钥可以访问的分组。', 'form-hint'));
  const heading = make('div', '', 'section-heading'); heading.append(titleBox, create);
  const search = make('input'); search.type = 'search'; search.placeholder = '搜索名称或分组'; search.setAttribute('aria-label', '搜索 API 密钥');
  const groupFilter = make('select'); groupFilter.setAttribute('aria-label', '按分组筛选 API 密钥');
  const count = make('span', '', 'form-hint'); count.setAttribute('role', 'status');
  const toolbar = make('div', '', 'caller-toolbar'); toolbar.append(search, groupFilter, count);
  const columns = make('div', '', 'caller-list-columns'); columns.setAttribute('aria-hidden', 'true');
  for (const label of ['名称 / 状态', '可用分组', '有效期', '操作']) columns.append(make('span', label));
  root.append(heading, toolbar, status, columns, list, dialog);
  search.addEventListener('input', renderList); groupFilter.addEventListener('change', renderList);
  let filterOptions = '';
  let session = null;
  // One listener for the persistent dialog; it targets whichever editor is open (same path as Esc and the × button).
  let requestClose = null;
  closeOnBackdrop(dialog, () => requestClose?.());

  function renderList() {
    list.replaceChildren();
    const config = getConfig();
    const poolNames = new Map((config?.pools || []).map((pool) => [pool.id, pool.name]));
    const nextOptions = JSON.stringify([...poolNames]);
    if (nextOptions !== filterOptions) {
      const selected = groupFilter.value;
      const all = make('option', '全部分组'); all.value = ''; groupFilter.replaceChildren(all);
      for (const [id, name] of poolNames) { const option = make('option', name); option.value = id; groupFilter.append(option); }
      groupFilter.value = poolNames.has(selected) ? selected : ''; filterOptions = nextOptions;
    }
    const query = search.value.trim().toLocaleLowerCase();
    const callers = config?.callers || [];
    for (const caller of callers) {
      const groupIds = grantedPoolIds(caller.permissions), groups = groupIds.map((id) => poolNames.get(id) || id);
      if (groupFilter.value && !groupIds.includes(groupFilter.value)) continue;
      if (query && ![caller.name, ...groups].some((value) => value.toLocaleLowerCase().includes(query))) continue;
      const row = make('article', '', 'caller-row'); row.setAttribute('data-caller-id', caller.id);
      const identity = make('div', '', 'caller-identity');
      const expired = caller.expiresAt && Date.parse(caller.expiresAt) <= Date.now();
      const enabled = caller.enabled && caller.subjectEnabled && !expired;
      const badge = make('span', expired ? '已到期' : enabled ? '已启用' : '已停用', `caller-status ${enabled ? 'is-enabled' : ''}`);
      identity.append(make('strong', caller.name), badge, make('small', caller.keyStored ? '密钥已保存' : '旧密钥待导入', 'form-hint'));
      const groupButton = button('', () => openEditor(caller, groupButton, undefined, true), 'caller-group-button');
      groupButton.setAttribute('aria-label', `${caller.name}：更改可用分组`);
      for (const group of groups) groupButton.append(make('span', group, 'caller-group-chip'));
      if (!groups.length) groupButton.append(make('span', '未选分组 · 暂无调用权限', 'form-hint'));
      groupButton.append(make('span', '更改 ›', 'caller-group-edit'));
      const expiry = make('div', '', 'caller-expiry');
      expiry.append(make('span', '有效期', 'caller-mobile-label'), make('span', caller.expiresAt ? new Date(caller.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '长期有效'));
      const edit = button('编辑', () => openEditor(caller, edit));
      const toggle = button(caller.enabled ? '停用密钥' : '启用密钥', () => openEditor(caller, toggle, caller.enabled ? 'disable' : 'enable'));
      const rotate = button('重新签发密钥', () => {
        if (window.confirm('重新签发后，旧密钥将在新配置生效时失效。确认继续？')) openEditor(caller, rotate, 'rotate');
      });
      const more = make('details', '', 'caller-more'), moreTitle = make('summary', '更多');
      const menu = make('div', '', 'caller-more-menu'); menu.append(toggle, rotate); more.append(moreTitle, menu);
      const actions = make('div', '', 'caller-actions');
      row.append(identity, groupButton, expiry, actions);
      if (caller.keyStored === true) {
        const copyKey = button('复制密钥', () => copyStoredKey(caller, copyKey));
        actions.append(copyKey, edit, more);
      } else {
        const panel = importPanel(caller);
        const importKey = button('导入旧密钥', () => { panel.hidden = !panel.hidden; if (!panel.hidden) panel.querySelector('input')?.focus(); });
        actions.append(importKey, edit, more); row.append(panel);
      }
      list.append(row);
    }
    count.textContent = `${list.children.length} / ${callers.length} 把密钥`;
    if (!list.children.length) list.append(make('p', callers.length ? '没有匹配的 API 密钥，试试其他名称或分组。' : '暂无 API 密钥。新增后先选择分组，再按需启用。', 'caller-empty form-hint'));
  }

  const keyUrl = (caller, suffix = '') => `/api/gateway/callers/${encodeURIComponent(caller.id)}/key${suffix}`;
  const keyRequest = (caller, suffix, body = {}) => api(keyUrl(caller, suffix), { method: 'POST', body: JSON.stringify(body) });

  async function copyStoredKey(caller, trigger) {
    trigger.disabled = true;
    try {
      const { token } = await keyRequest(caller, '');
      if (await copyText(token, document)) notify('密钥已复制');
      else showKey(token, trigger);
    } catch (error) {
      if (error.status === 404) { await refresh(); renderList(); notify('这把 API 密钥未保存，可以导入旧密钥或重新签发', 'error'); }
      else notify(`读取密钥失败：${error.message}`, 'error');
    } finally { trigger.disabled = false; }
  }

  // Older tokens were created before keys were stored: the user pastes the key they still hold; the server only accepts it
  // when it matches the token's published hash, so nothing changes for clients that are using the token.
  function importPanel(caller) {
    const panel = make('div', '', 'caller-key-import'); panel.hidden = true;
    const label = make('label', '粘贴旧密钥'), input = make('input');
    input.type = 'password'; input.autocomplete = 'off'; input.maxLength = 256; input.name = 'importKey';
    input.setAttribute('aria-label', `${caller.name} 的旧密钥`); label.append(input);
    const message = make('p', '', 'form-status'); message.setAttribute('role', 'alert');
    const save = button('保存', async () => {
      const value = input.value.trim();
      if (!value) { message.textContent = '请先粘贴旧密钥'; return; }
      save.disabled = true; message.textContent = '';
      try {
        await keyRequest(caller, '/import', { token: value });
        input.value = '';
        notify('密钥已保存，可以复制了');
        await refresh(); renderList();
      } catch (error) {
        message.textContent = error.status === 422 ? '密钥和此记录不匹配'
          : error.status === 400 ? '密钥格式不正确' : `保存失败：${error.message}`;
        save.disabled = false;
      }
    }, 'button button-primary');
    panel.append(label, save, message,
      make('p', '旧记录没有保存密钥，粘贴你手里的旧密钥即可，不影响正在使用的客户端；也可以重新签发新密钥。', 'form-hint'));
    return panel;
  }

  const refresh = async () => { try { await refreshConfig(); } catch { /* the list keeps the last known state */ } };

  // Last resort when the browser refuses to copy: show the key selected so Ctrl+C works.
  const keyDialog = make('dialog', '', 'caller-key-dialog');
  keyDialog.onclose = () => { keyDialog.replaceChildren(); };
  closeOnBackdrop(keyDialog, () => keyDialog.close());
  root.append(keyDialog);
  function showKey(value, trigger) {
    const box = make('textarea'); box.readOnly = true; box.rows = 3; box.autocomplete = 'off'; box.value = value;
    box.setAttribute('aria-label', 'API 密钥');
    const done = button('关闭', () => keyDialog.close(), 'button button-primary');
    const actions = make('div', '', 'dialog-actions'); actions.append(done);
    keyDialog.replaceChildren(make('h2', '复制密钥'), make('p', '浏览器没有允许自动复制。密钥已选中，按 Ctrl+C 复制。', 'form-hint'), box, actions);
    keyDialog.onclose = () => { box.value = ''; keyDialog.replaceChildren(); trigger?.focus?.(); };
    keyDialog.showModal(); box.focus(); box.select?.();
  }

  function openEditor(caller, trigger, action, focusGroups = false) {
    if (session && !session.draft.closed) return;
    dialog.replaceChildren();
    // The editor only edits whole-group grants. Pools named by the token's current permissions are pre-ticked and the draft
    // starts as one group grant per such pool (config order), so opening a token is not an edit but saving converts it.
    const granted = new Set(caller ? grantedPoolIds(caller.permissions) : []);
    const legacy = Boolean(caller) && caller.permissions.some((row) => !isGroupGrant(row));
    const draftCaller = caller && { ...caller, permissions: getConfig().pools.filter((pool) => granted.has(pool.id)).map((pool) => groupGrant(pool.id)) };
    const config = getConfig();
    const form = make('form', '', 'gateway-editor-shell caller-editor'); form.noValidate = true;
    const header = make('header', '', 'dialog-heading channel-settings-heading');
    const editorTitle = make('h2', caller ? `编辑 API 密钥 · ${caller.name}` : '新增 API 密钥'); editorTitle.id = 'gateway-caller-editor-title';
    const closeIcon = button('×', () => close(), 'icon-button'); closeIcon.setAttribute('aria-label', '关闭 API 密钥编辑器'); closeIcon.setAttribute('data-editor-close', '');
    const titleBox = make('div'); titleBox.append(make('span', 'API KEY', 'dialog-kicker'), editorTitle);
    dialog.setAttribute('aria-labelledby', editorTitle.id); header.append(titleBox, closeIcon);
    const body = make('div', '', 'gateway-editor-body');
    const fields = make('fieldset', '', 'settings-group caller-basic'); fields.append(make('legend', '基本信息'));
    const controls = {};
    const labelInput = (name, label, type = 'text', container = fields) => {
      const wrapper = make('label', label), input = make('input'); input.name = name; input.type = type;
      wrapper.append(input); container.append(wrapper); controls[name] = input; return input;
    };
    const nameInput = labelInput('name', '密钥名称'); nameInput.maxLength = 120; nameInput.placeholder = '例如：Codex 家里 / AstrBot';
    labelInput('enabled', '启用此密钥', 'checkbox');
    if (!caller) fields.append(make('p', '新密钥默认停用。保存并复制后，在列表中启用。', 'form-hint'));
    const advanced = make('details', '', 'caller-advanced'); advanced.open = Boolean(caller && (!caller.subjectEnabled || caller.expiresAt || caller.allowedIps.length));
    const limits = make('fieldset', '', 'settings-group caller-limits');
    advanced.append(make('summary', '高级限制 · 到期时间与 IP 白名单'), limits);
    labelInput('subjectEnabled', '允许此调用身份访问网关', 'checkbox', limits);
    labelInput('expiresAt', '到期 UTC 时间（留空长期有效，例如 2027-01-01T00:00:00Z）', 'text', limits);
    labelInput('allowedIps', 'IP 白名单 / CIDR（逗号分隔；留空不限来源）', 'text', limits);
    const permissions = make('fieldset', '', 'settings-group caller-permissions'); permissions.append(make('legend', '可用分组'));
    const selectedCount = make('strong'); selectedCount.setAttribute('role', 'status');
    const selectedGroups = make('div', '', 'caller-selected-groups'); selectedGroups.setAttribute('aria-label', '已选分组');
    const groupSearch = make('input'); groupSearch.type = 'search'; groupSearch.placeholder = '搜索分组或渠道'; groupSearch.setAttribute('aria-label', '搜索可用分组');
    const permissionRows = make('div', '', 'caller-group-options');
    const noMatches = make('p', '没有匹配的分组，换个关键词试试。', 'form-hint'); noMatches.hidden = true;
    // Shown only while the opened token's permissions were finer than whole groups (per channel / protocol / model).
    const legacyNote = make('p', '此密钥原来按渠道或协议细分授权，保存后改为按分组授权：可用所选分组的全部渠道和全部模型', 'dialog-note');
    legacyNote.setAttribute('data-group-legacy-note', ''); legacyNote.hidden = !legacy;
    const emptyHint = make('p', '未选择分组，这把密钥没有模型调用权限。', 'form-hint'); emptyHint.setAttribute('data-group-empty-hint', '');
    permissions.append(make('p', '支持多选。更改后点保存生效，密钥不变；分组新增渠道、渠道新增模型后自动可用。', 'form-hint'), legacyNote, selectedCount, selectedGroups, groupSearch, permissionRows, noMatches, emptyHint);
    body.append(fields, permissions, advanced);
    const error = make('p', '', 'form-status'); error.setAttribute('role', 'alert');
    const result = make('p', '', 'form-hint'); result.setAttribute('role', 'status'); result.setAttribute('tabindex', '-1');
    const tokenBox = make('section', '', 'settings-group gateway-token-box'); tokenBox.hidden = true;
    const token = make('textarea'); token.readOnly = true; token.rows = 3; token.autocomplete = 'off'; token.setAttribute('aria-label', '仅本次显示的新 API 密钥');
    const forget = button('已保存，清除本次显示', () => session.clearToken());
    const copy = button('复制密钥', () => copyToken(), 'button button-primary');
    const copyActions = make('div', '', 'gateway-token-actions'); copyActions.append(copy, forget);
    // 复制逻辑（含 http 页面的兜底）见 clipboard.js。
    async function copyToken() {
      const value = token.value;
      if (!value) return;
      // The dialog is modal, so the visible textarea is the only field that can be focused and selected.
      const copied = await copyText(value, document, token);
      copy.textContent = copied ? '已复制' : '复制失败，请手动选中复制';
      notify(copied ? '密钥已复制到剪贴板' : '浏览器拒绝了复制，请在文本框里手动选中复制', copied ? 'normal' : 'error');
      setTimeout(() => { copy.textContent = '复制密钥'; }, 2000);
    }
    token.addEventListener('focus', () => token.select());
    tokenBox.append(make('strong', '新密钥仅本次显示'), make('p', '请立即复制并妥善保存。关闭后清除，不会出现在列表或后续编辑中。', 'form-hint'), token, copyActions);
    const dismiss = () => { session.close(); token.value = ''; dialog.close(); };
    const close = () => {
      if (session.draft.saving) { error.textContent = '正在保存，请等待结果后关闭'; return; }
      if (session.draft.oneTimeToken && !window.confirm('新密钥仅本次显示，确认已保存并清除此处显示？')) return;
      if (session.draft.status === 'unknown' && !window.confirm('保存结果尚待核对。关闭后请先核对配置再创建。仍要关闭？')) return;
      if (session.dirty && !['active', 'pending', 'unknown'].includes(session.draft.status) && !window.confirm('放弃未保存的 API 密钥设置？')) return;
      dismiss();
    };
    // Close and confirm only when nothing else must stay visible: a fresh one-time token (or the notice that it
    // could not be recovered) needs the dialog, and 202/pending or failures keep the reconcile button and draft.
    let receipt = null;
    const settle = () => {
      const { closed, status, oneTimeToken, tokenUnavailable } = session.draft;
      if (closed || status !== 'active' || oneTimeToken || tokenUnavailable) return;
      dismiss();
      notify(`已保存 · gen ${receipt?.servingGen ?? receipt?.desiredGen}`);
    };
    const cancel = button('取消 / 关闭', close);
    const reconcile = button('重试生效', async () => { await session.reconcile(); settle(); }); reconcile.hidden = true;
    const save = button('保存', () => {} , 'button button-primary'); save.type = 'submit';
    const actions = make('div', '', 'dialog-actions'); actions.append(cancel, reconcile, save);
    const footer = make('footer', '', 'settings-footer gateway-editor-footer'); footer.append(error, result, actions);
    form.append(header, body, tokenBox, footer); dialog.append(form);

    requestClose = () => close();
    let initial = true, previousStatus;
    const setGroup = (id, checked) => {
      const next = new Set(session.draft.permissions.map((item) => item.poolId));
      if (checked) next.add(id); else next.delete(id);
      session.edit({ permissions: config.pools.filter((item) => next.has(item.id)).map((item) => groupGrant(item.id)) });
    };
    // Keep the controls mounted while filtering or selecting so focus and scroll do not jump.
    const groupRows = config.pools.map((pool, index) => {
      const members = config.channels.filter((channel) => (channel.poolIds ?? [channel.poolId]).includes(pool.id));
      const row = make('label', '', 'caller-group-row');
      const input = make('input'); input.type = 'checkbox'; input.value = pool.id;
      input.setAttribute('data-permission-control', `group-${index}`); input.setAttribute('aria-label', pool.name);
      const hint = make('span', members.length
        ? `${members.length} 个渠道：${members.map((channel) => `${channel.name || `#${channel.id}`}${channel.enabled === false ? '（已停用）' : ''}`).join('、')}`
        : '暂无渠道', 'form-hint caller-group-channels');
      hint.id = `gateway-caller-group-channels-${index}`; input.setAttribute('aria-describedby', hint.id);
      const content = make('span', '', 'caller-group-content'); content.append(make('strong', pool.name), hint);
      const mark = make('span', '', 'caller-group-mark'); mark.setAttribute('aria-hidden', 'true');
      input.addEventListener('change', () => setGroup(pool.id, input.checked));
      row.append(input, content, mark); permissionRows.append(row);
      return { pool, row, input, mark, searchText: [pool.name, pool.id, ...members.map((channel) => channel.name || channel.id)].join(' ').toLocaleLowerCase() };
    });
    if (!groupRows.length) permissionRows.append(make('p', '暂无可选分组，请先在渠道页添加分组。', 'form-hint'));
    const filterGroups = () => {
      const query = groupSearch.value.trim().toLocaleLowerCase();
      for (const item of groupRows) item.row.hidden = !item.searchText.includes(query);
      noMatches.hidden = !groupRows.length || groupRows.some((item) => !item.row.hidden);
    };
    groupSearch.addEventListener('input', filterGroups);
    const renderPermissions = () => {
      const selected = new Set(session.draft.permissions.map((row) => row.poolId));
      selectedCount.textContent = `已选 ${selected.size} 个分组`;
      selectedGroups.replaceChildren();
      for (const item of groupRows) {
        const checked = selected.has(item.pool.id);
        item.input.checked = checked; item.row.setAttribute('data-selected', String(checked)); item.mark.textContent = checked ? '已选择' : '选择';
        if (checked) {
          const remove = button(`${item.pool.name} ×`, () => {
            setGroup(item.pool.id, false);
            (item.row.hidden ? groupSearch : item.input).focus();
          }, 'caller-group-chip caller-group-remove');
          remove.setAttribute('aria-label', `移除 ${item.pool.name} 分组`); selectedGroups.append(remove);
        }
      }
      emptyHint.hidden = selected.size > 0;
      legacyNote.hidden = !legacy || ['active', 'pending'].includes(session.draft.status);
    };
    session = createCallerSession({ config: getConfig(), caller: draftCaller, api,
      onSaved: async (saved) => { receipt = saved; await onSaved(saved); renderList(); },
      onChange: (draft) => {
        if (draft.closed) return;
        error.textContent = draft.error;
        result.textContent = (draft.status === 'active' ? '已生效' : draft.status === 'pending' ? '已保存，等待生效；当前仍使用原配置。' : draft.status === 'unknown' ? '结果尚待核对；重试沿用同一操作。' : '')
          + (draft.tokenUnavailable ? ' 本次密钥未取回，重复操作不会再次生成。请关闭后核对 API 密钥列表，再主动重新签发密钥。' : '');
        const locked = draft.saving || ['pending', 'unknown', 'active'].includes(draft.status);
        fields.disabled = permissions.disabled = limits.disabled = locked;
        save.disabled = draft.saving || ['pending', 'active'].includes(draft.status);
        save.textContent = draft.saving ? '保存中' : draft.status === 'unknown' ? '核对并重试同一操作' : '保存';
        reconcile.hidden = draft.status !== 'pending'; reconcile.disabled = draft.saving;
        tokenBox.hidden = !draft.oneTimeToken; token.value = draft.oneTimeToken;
        if (!initial) renderPermissions();
        if (draft.status === 'active' && previousStatus !== 'active') result.focus();
        previousStatus = draft.status;
      } });
    for (const name of ['name', 'enabled', 'subjectEnabled', 'expiresAt', 'allowedIps']) {
      const node = controls[name]; node[node.type === 'checkbox' ? 'checked' : 'value'] = name === 'allowedIps' ? session.draft.allowedIps.join(', ') : session.draft[name] ?? '';
      node.addEventListener(node.type === 'checkbox' ? 'change' : 'input', () => session.edit({ [name]: node.type === 'checkbox' ? node.checked : name === 'allowedIps'
        ? [...new Set(node.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))] : name === 'expiresAt' ? node.value || null : node.value }));
    }
    if (!caller) { controls.enabled.disabled = true; controls.enabled.checked = false; }
    form.addEventListener('submit', async (event) => { event.preventDefault(); await session.save(); settle(); });
    form.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.tagName === 'INPUT') event.preventDefault(); });
    dialog.oncancel = (event) => { event.preventDefault(); close(); };
    dialog.onclose = () => { requestClose = null; session.close(); token.value = ''; dialog.replaceChildren(); trigger?.focus(); };
    initial = false; renderPermissions(); dialog.showModal();
    if (focusGroups) { permissions.scrollIntoView?.({ block: 'start' }); groupSearch.focus(); }
    else controls.name.focus();
    if (action) session.save(action).then(settle);
    return session;
  }
  renderList();
  return { render: renderList, openEditor };
}
