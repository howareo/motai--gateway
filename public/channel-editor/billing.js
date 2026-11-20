// Billing uses only the saved channel snapshot. Connection/key drafts never
// cross this boundary; management credentials stay in the existing wallet UI.
export function mountGatewayBilling({ root, channelId, getChannel, renderCost, renderPrice, renderWallet, openSettings }) {
  const document = root.ownerDocument;
  const make = (tag, text = '', className = '') => {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  };
  const note = make('p', '', 'form-hint'); note.setAttribute('role', 'status');
  const summary = make('div', '', 'settings-group');
  const actions = make('div', '', 'dialog-actions');
  const cost = make('button', '成本设置', 'button button-secondary'); cost.type = 'button';
  const wallet = make('button', '余额设置', 'button button-secondary'); wallet.type = 'button';
  const open = (tab, trigger) => { if (channelId && getChannel(channelId)) openSettings(channelId, tab, trigger); };
  cost.addEventListener('click', () => open('config', cost));
  wallet.addEventListener('click', () => open('wallet', wallet));
  actions.append(cost, wallet); root.replaceChildren(note, summary, actions);
  const refresh = () => {
    const channel = channelId ? getChannel(channelId) : null;
    actions.hidden = !channel;
    if (!channel) {
      note.textContent = channelId ? '渠道数据尚未就绪，请刷新后再管理价格与余额。' : '先保存渠道，再配置成本与账户余额。';
      summary.replaceChildren(); return;
    }
    note.textContent = `${channel.billingStale ? '数据待同步，保留最近已知值。' : ''}显示已保存渠道的价格与账户余额；连接草稿单独保存。成本与余额设置各自生效。`;
    // Periodic overview refresh must not replace an actively used selector or
    // refresh button. Stable settings buttons live outside the summary.
    if (summary.contains(document.activeElement)) return;
    summary.replaceChildren(make('h3', '当前成本倍率'), renderCost(channel),
      make('h3', '官方价格折算'), renderPrice(channel), make('h3', '账户余额'),
      renderWallet(channel, () => open('wallet', wallet)));
  };
  refresh();
  return { refresh };
}
