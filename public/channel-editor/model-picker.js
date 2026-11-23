import { modelPage, selectFilteredModels, setSelectedModels, fetchModelSets, groupModelsByVendor, resolveFetchTab, toggleModelGroup, FETCH_TABS } from './state.js';

// Both forms use native controls and the same draft; only the current 50 rows enter the DOM.
export function mountModelPicker(root, { getDraft, setDraft, onChange = () => {} }) {
  const document = root.ownerDocument;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = make('button', text, 'button button-secondary');
    node.type = 'button'; node.addEventListener('click', action); return node;
  };
  let page = 0;
  const searchLabel = make('label', '搜索模型 ID');
  const search = make('input'); search.type = 'search'; search.autocomplete = 'off';
  searchLabel.append(search);
  const filterLabel = make('label', '目录范围');
  const filter = make('select');
  for (const [value, text] of [['all', '全部'], ['selected', '已选'], ['added', '本次新增'], ['missing', '上游未返回']]) {
    const option = make('option', text); option.value = value; filter.append(option);
  }
  filterLabel.append(filter);
  const toolbar = make('div', '', 'model-picker-toolbar'); toolbar.append(searchLabel, filterLabel);
  const summary = make('p', '', 'form-hint'); summary.setAttribute('aria-live', 'polite');
  const list = make('div', '', 'model-picker-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', '模型选择');
  const change = (next) => { setDraft(next); onChange(next); render(); };
  const actions = make('div', '', 'model-picker-actions');
  const selectAll = button('全选筛选结果', () => change(selectFilteredModels(getDraft(), search.value, filter.value, true)));
  const clearAll = button('取消筛选结果', () => change(selectFilteredModels(getDraft(), search.value, filter.value, false)));
  actions.append(selectAll, clearAll);
  const pagination = make('div', '', 'model-picker-actions');
  const previous = button('上一页', () => { page--; render(); });
  const next = button('下一页', () => { page++; render(); });
  const pageInfo = make('span', '', 'form-hint'); pageInfo.setAttribute('aria-live', 'polite');
  pagination.append(previous, pageInfo, next);
  function render() {
    const draft = getDraft();
    if (!draft || draft.closed) return;
    const result = modelPage(draft, search.value, filter.value, page); page = result.page;
    summary.textContent = `已选 ${draft.selected.length} 个 · 目录 ${draft.discovered.length} 个 · 筛选结果 ${result.total} 个`;
    pageInfo.textContent = `${page + 1} / ${result.lastPage + 1}`;
    previous.disabled = page === 0; next.disabled = page === result.lastPage;
    selectAll.disabled = clearAll.disabled = result.total === 0;
    list.replaceChildren();
    for (const item of result.items) {
      const label = make('label', '', 'model-picker-row');
      const checkbox = make('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected;
      const id = make('span', item.id, 'model-picker-id'); id.title = item.id;
      const status = make('small', [item.selected ? '已选' : '未选', item.missing ? '上游未返回' : item.added ? '本次新增' : ''].filter(Boolean).join(' · '));
      checkbox.addEventListener('change', () => {
        const current = getDraft();
        change(setSelectedModels(current, checkbox.checked ? [...current.selected, item.id] : current.selected.filter((value) => value !== item.id)));
        const row = [...list.querySelectorAll('input')].find((node) => node.value === item.id);
        (row || search).focus({ preventScroll: true });
      });
      checkbox.value = item.id;
      label.append(checkbox, id, status); list.append(label);
    }
    if (!result.items.length) list.append(make('p', '没有匹配的模型；可在已选列表中手工补充。', 'form-hint'));
  }
  for (const control of [search, filter]) control.addEventListener(control === search ? 'input' : 'change', () => { page = 0; render(); });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); });
  root.replaceChildren(toolbar, actions, summary, list, pagination);
  render();
  return { render };
}

// 点遮罩关闭：按下和抬起都落在 <dialog> 本身才算（从内容里拖选到遮罩上不会误关）。
// 表单撑满整个 <dialog>，所以内容区的点击目标一定是后代元素，不会触发。
export function closeOnBackdrop(dialog, close) {
  let pressed = false;
  dialog.addEventListener('mousedown', (event) => { pressed = event.target === dialog; });
  dialog.addEventListener('click', (event) => {
    const hit = pressed && event.target === dialog; pressed = false;
    if (hit) close();
  });
}

const FETCH_TAB_LABELS = { new: '新增', existing: '已有', removed: '上游未返回' };

// 照 New API「获取模型」弹窗：搜索 + 三个标签页 + 按厂商分组的整组勾选，不分页。
// 勾选只在弹窗内的本地副本里变化；「确认」才通过 onConfirm 交给草稿，取消 / Esc / 遮罩 / × 都丢弃。
export function mountFetchModelsDialog({ host, getDraft, vendors = new Map(), channelName = () => '', discover, onConfirm }) {
  const document = host.ownerDocument;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
  };
  const button = (text, action, className = 'button button-secondary') => {
    const node = make('button', text, className); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const dialog = make('dialog', '', 'fetch-models-dialog');
  const shell = make('div', '', 'fetch-models-shell');
  const title = make('h2', '获取模型'); title.id = 'fetch-models-title';
  dialog.setAttribute('aria-labelledby', title.id);
  const subtitle = make('p', '', 'form-hint');
  const closeIcon = button('×', () => close(), 'icon-button'); closeIcon.setAttribute('aria-label', '关闭获取模型'); closeIcon.setAttribute('data-fetch-close', '');
  const titleBox = make('div'); titleBox.append(make('span', 'UPSTREAM', 'dialog-kicker'), title, subtitle);
  const header = make('header', '', 'dialog-heading'); header.append(titleBox, closeIcon);

  const search = make('input'); search.type = 'search'; search.autocomplete = 'off'; search.placeholder = '搜索模型…';
  search.setAttribute('aria-label', '搜索模型'); search.setAttribute('data-fetch-search', '');
  const toolbar = make('div', '', 'fetch-models-toolbar'); toolbar.append(search);
  const tabsNav = make('div', '', 'fetch-models-tabs'); tabsNav.setAttribute('role', 'tablist'); tabsNav.setAttribute('aria-label', '模型分类');
  const tabButtons = new Map(FETCH_TABS.map((name) => {
    const node = button('', () => { state.tab = name; render(); }, 'fetch-models-tab');
    node.setAttribute('role', 'tab'); node.setAttribute('data-fetch-tab', name); tabsNav.append(node); return [name, node];
  }));
  const body = make('div', '', 'fetch-models-body'); body.setAttribute('role', 'tabpanel');
  const count = make('span', '', 'fetch-models-count'); count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite');
  const cancel = button('取消', () => close()); cancel.setAttribute('data-fetch-cancel', '');
  const confirm = button('确认', () => {
    const selected = state.selected; close(); onConfirm(selected);
  }, 'button button-primary'); confirm.setAttribute('data-fetch-confirm', '');
  const actions = make('div', '', 'dialog-actions'); actions.append(cancel, confirm);
  const footer = make('footer', '', 'fetch-models-footer'); footer.append(count, actions);
  shell.append(header, toolbar, tabsNav, body, footer); dialog.append(shell); host.append(dialog);

  const state = { selected: [], search: '', tab: null, collapsed: new Set() };
  const reset = () => { state.selected = []; state.search = ''; state.tab = null; state.collapsed.clear(); search.value = ''; };
  function render() {
    const draft = getDraft();
    if (!draft || draft.closed) return;
    const ready = draft.discoveryStatus === 'ready';
    toolbar.hidden = tabsNav.hidden = !ready; confirm.disabled = !ready;
    count.textContent = `已选 ${state.selected.length} 个模型`;
    const focusKey = document.activeElement?.getAttribute?.('data-fetch-focus'), scroll = body.scrollTop;
    body.replaceChildren();
    if (!ready) {
      if (draft.discoveryStatus === 'loading') {
        const loading = make('p', '正在拉取上游模型…', 'fetch-models-message'); loading.setAttribute('role', 'status'); body.append(loading);
      } else {
        const failed = make('div', '', 'fetch-models-message');
        failed.append(make('p', draft.discoveryError || '还没有拉取到上游模型'));
        const retry = button('重试', () => { discover(); render(); }, 'button button-primary'); retry.setAttribute('data-fetch-retry', '');
        failed.append(retry); body.append(failed);
      }
      return;
    }
    const sets = fetchModelSets(draft, state.search), active = resolveFetchTab(sets, state.tab), picked = new Set(state.selected);
    for (const [name, node] of tabButtons) {
      node.textContent = `${FETCH_TAB_LABELS[name]} (${sets[name].length})`;
      node.disabled = sets[name].length === 0; node.setAttribute('aria-selected', String(name === active)); node.tabIndex = name === active ? 0 : -1;
    }
    const groups = groupModelsByVendor(sets[active], vendors);
    if (!groups.length) body.append(make('p', '没有匹配的模型', 'fetch-models-message'));
    for (const { vendor, models } of groups) {
      const key = `${active}:${vendor}`, open = !state.collapsed.has(key), chosen = models.filter((id) => picked.has(id)).length;
      const section = make('section', '', 'fetch-models-group'); section.setAttribute('data-fetch-group', vendor);
      const toggle = button(`${open ? '▾' : '▸'} ${vendor} (${models.length})`, () => {
        if (state.collapsed.has(key)) state.collapsed.delete(key); else state.collapsed.add(key); render();
      }, 'fetch-models-group-toggle');
      toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('data-fetch-focus', `g:${key}`);
      const selectedInfo = make('span', `已选 ${chosen} / ${models.length}`, 'form-hint');
      const all = make('input'); all.type = 'checkbox'; all.checked = chosen === models.length; all.indeterminate = chosen > 0 && chosen < models.length;
      all.setAttribute('aria-label', `选择 ${vendor} 当前结果全部 ${models.length} 个`); all.setAttribute('data-fetch-group-check', vendor); all.setAttribute('data-fetch-focus', `c:${key}`);
      all.addEventListener('change', () => { state.selected = toggleModelGroup(state.selected, models, all.checked); render(); });
      const head = make('div', '', 'fetch-models-group-head'); head.append(toggle, selectedInfo, all); section.append(head);
      if (open) {
        const list = make('div', '', 'fetch-models-grid');
        for (const id of models) {
          const row = make('label', '', 'fetch-models-row'), box = make('input'); box.type = 'checkbox'; box.value = id; box.checked = picked.has(id);
          box.setAttribute('data-fetch-model', id); box.setAttribute('data-fetch-focus', `m:${id}`);
          box.addEventListener('change', () => { state.selected = toggleModelGroup(state.selected, [id], box.checked); render(); });
          const name = make('span', id, 'model-picker-id'); name.title = id; row.append(box, name); list.append(row);
        }
        section.append(list);
      }
      body.append(section);
    }
    body.scrollTop = scroll;
    if (focusKey) [...body.querySelectorAll('[data-fetch-focus]')].find((node) => node.getAttribute('data-fetch-focus') === focusKey)?.focus();
  }

  function close() { if (dialog.open) dialog.close(); }
  search.addEventListener('input', () => { state.search = search.value; render(); });
  search.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); });
  dialog.oncancel = (event) => { event.preventDefault(); close(); };
  dialog.onclose = () => reset();
  closeOnBackdrop(dialog, close);

  return {
    get isOpen() { return Boolean(dialog.open); },
    // 调用方已通过凭据确认后再调用：弹窗打开即自动拉取（拉取中显示加载，失败或为空显示"重试"）。
    open() {
      reset(); state.selected = [...getDraft().selected]; subtitle.textContent = channelName();
      dialog.showModal(); discover(); render();
    },
    refresh() { if (dialog.open) render(); },
    close,
  };
}
