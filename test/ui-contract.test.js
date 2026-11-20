import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolvePeriod } from '../src/calendar-periods.js';

const appPath = new URL('../public/app.js', import.meta.url);
const cssPath = new URL('../public/styles.css', import.meta.url);
const htmlPath = new URL('../public/index.html', import.meta.url);

test('renders missing metric and request values as empty strings', async () => {
  const [app, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.doesNotMatch(app, /数据不可用|未采集|未提供|不适用/);
  assert.doesNotMatch(html, />—</);
  assert.match(app, /value === null \|\| value === undefined \? '' : compact\.format\(value\)/);
  assert.match(app, /badge\.textContent = value \|\| ''/);
});

test('keeps cache colors consistent and OpenAI distinct from cache read', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);
  const openAi = css.match(/--openai:\s*([^;]+);/)?.[1];
  const cacheRead = css.match(/--cache-read:\s*([^;]+);/)?.[1];

  assert.ok(openAi);
  assert.ok(cacheRead);
  assert.notEqual(openAi, cacheRead);
  assert.match(css, /--cache-write:\s*#e9d467;/);
  assert.match(css, /--cache-read:\s*#8ebfea;/);
  assert.match(css, /\.token-cache-write em, \.token-cache-write b \{ color: var\(--cache-write\); \}/);
  assert.match(css, /\.token-cache-read em, \.token-cache-read b \{ color: var\(--cache-read\); \}/);
  assert.match(app, /'缓存写', log\.cacheCreateTokens, 'cache-write'/);
  assert.match(app, /'缓存读', log\.cacheReadTokens, 'cache-read'/);
  assert.match(html, /class="metric metric-cache-read"/);
  assert.match(html, /class="metric metric-cache-write"/);
});

test('assigns a stable color to each channel across overview, cost, and request details', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(app, /const channelColors = \{/);
  assert.match(app, /anthropic: \['#d4a06c'/);
  assert.match(app, /openai: \['#62cfe0'/);
  assert.match(app, /xai: \['#b8c4d6'/);
  assert.match(app, /type\.includes\('xai'\)/);
  assert.match(app, /function channelColor\(channelId, providerFamily = ''\)/);
  assert.match(app, /applyChannelColor\(row, channel\.id, providerFamilyOf\(channel\)\)/);
  assert.match(app, /applyChannelColor\(row, model\.channelId, model\.providerFamily\)/);
  assert.match(app, /applyChannelColor\(row, log\.channelId, log\.providerFamily\)/);
  assert.match(css, /\.channel-row \.channel-main \{ box-shadow: inset 2px 0 0 var\(--channel-color\); \}/);
  assert.match(css, /\.channel-distribution-row \.model-track::after \{ background: var\(--channel-color\); \}/);
  assert.match(css, /\.request-success-row \.request-route \{ box-shadow: inset 2px 0 0 var\(--channel-color\); \}/);
  assert.match(css, /\.request-error-row \.request-route \{ box-shadow: inset 2px 0 0 var\(--danger\); \}/);
  assert.match(css, /\.request-family-anthropic \.request-model \{ color: var\(--claude\); \}/);
  assert.match(css, /\.request-family-openai \.request-model \{ color: var\(--openai\); \}/);
  assert.match(css, /\.request-family-xai \.request-model \{ color: var\(--xai\); \}/);
  assert.match(html, /value="48">xAI \/ Grok/);
});

test('renders every reasoning effort with a distinct stable badge style', async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
  ]);
  const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  // 每档一个色相，各档文字色互不相同。
  const colors = levels.map((level) => {
    const rule = css.match(new RegExp(`\\.reasoning-${level} \\{([^}]*)\\}`))?.[1];
    assert.ok(rule, `missing reasoning-${level} style`);
    return rule.match(/color: (#[0-9a-fA-F]{6})/)?.[1].toLowerCase();
  });

  assert.match(app, /const reasoningLevels = new Set\(\['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'\]\)/);
  assert.match(app, /reasoningLevels\.has\(normalized\) \? normalized : 'other'/);
  assert.match(app, /badge\.className = value \? `reasoning-badge reasoning-\$\{level\}` : 'reasoning-empty'/);
  assert.match(css, /\.reasoning-badge \{[^}]*min-width: 62px;[^}]*justify-content: center;/);
  assert.match(css, /@media \(max-width: 719px\) \{\s*\.topbar \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto auto;/);
  assert.match(css, /@media \(max-width: 719px\)[\s\S]*?\.page-nav \{ position: fixed;[^}]*env\(safe-area-inset-bottom\)/);
  assert.ok(colors.every(Boolean), 'every level needs its own text color');
  assert.equal(new Set(colors).size, levels.length);
});

test('paginates filtered requests in 100-row pages', async () => {
  const [app, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(app, /const requestPageSize = 100;/);
  assert.match(html, /id="request-page-first"/);
  assert.match(html, /id="request-page-prev"/);
  assert.match(html, /id="request-page-next"/);
  assert.match(html, /id="request-page-last"/);
  assert.match(html, /id="request-page-summary"/);
});

test('initial document contains every eagerly bound application element', async () => {
  const [app, html] = await Promise.all([readFile(appPath, 'utf8'), readFile(htmlPath, 'utf8')]);
  const bindings = app.match(/const elements = \{([\s\S]*?)\n\};/)[1];
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const missing = [...bindings.matchAll(/\$\('#([^']+)'\)/g)].map((match) => match[1]).filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], 'missing elements abort application initialization before its first API request');
});

test('refreshes the request timeline through the bounded recent-log endpoint', async () => {
  const [app, server] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);

  assert.match(app, /async function loadRequests\(/);
  assert.match(app, /api\(`\/api\/requests\?\$\{query\}`\)/);
  assert.match(app, /elements\.requestRefresh\.addEventListener\('click', \(\) => loadRequests\(\{ fresh: true, quiet: false \}\)\)/);
  assert.doesNotMatch(app, /elements\.requestRefresh\.addEventListener\('click', \(\) => refresh\(\{ force: true \}\)\)/);
  assert.match(server, /const RECENT_LOG_LIMIT = 100/);
  assert.match(server, /url\.pathname === '\/api\/recent-requests'/);
  assert.match(server, /url\.pathname === '\/api\/requests'/);
});

test('uses cached overview polling and reports upstream rate limiting without clearing the dashboard', async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
  ]);

  assert.match(app, /cacheStatus === 'stale'/);
  assert.match(app, /New API 限流 · 显示缓存/);
  assert.match(app, /New API 后台日志限流/);
  assert.match(app, /query\.set\('force', '1'\)/);
  assert.match(app, /setInterval\(\(\) => \{\s*if \(document\.hidden\) return;\s*refresh\(\{ quiet: true \}\);\s*\}, 60_000\)/);
  assert.match(app, /document\.addEventListener\('visibilitychange', \(\) => \{/);
  assert.match(app, /Date\.now\(\) - state\.lastRefreshAt >= 60_000/);
  assert.match(app, /state\.rateLimitedUntil = Date\.now\(\) \+ 2 \* 60_000/);
  assert.doesNotMatch(app, /rateLimitRetryTimer/);
  assert.match(css, /\.connection-state\.limited/);
});

test('skips re-rendering when the overview is unchanged and pauses background switching state', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(app, /renderedPeriodKey: null/);
  assert.match(app, /lastRefreshAt: 0/);
  assert.match(app, /state\.renderedPeriodKey = state\.periodKey;/);
  assert.match(app, /const unchanged = Boolean\(\s*state\.overview\s*&& overview\.generatedAt\s*&& overview\.generatedAt === state\.overview\.generatedAt\s*&& state\.renderedPeriodKey === requestedPeriodKey,?\s*\);/);
  assert.match(app, /if \(!unchanged\) \{\s*render\(\);\s*\}/);
  assert.match(app, /elements\.overview\.classList\.add\('is-switching'\)/);
  assert.match(app, /elements\.overview\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(app, /elements\.overview\.classList\.remove\('is-switching'\)/);
  assert.match(app, /elements\.overview\.removeAttribute\('aria-busy'\)/);
  assert.match(css, /\.content-wrap\.is-switching \.metric-matrix, \.content-wrap\.is-switching \.analytics-grid, \.content-wrap\.is-switching \.data-section \{ opacity: \.45; pointer-events: none; \}/);
  assert.match(html, /id="connection-state" class="connection-state" aria-live="polite"/);
});

test('opens the loopback console without a browser login flow', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.doesNotMatch(html, /login-dialog|login-form|管理员账号|管理员密码|登录控制台/);
  assert.doesNotMatch(app, /\/api\/session|loginDialog|async function login/);
  assert.doesNotMatch(css, /\.login-dialog|\.login-shell/);
});

test('defaults cost distribution to channels and only offers channel or model test views', async () => {
  const [app, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(app, /costDistributionMode: 'channel'/);
  assert.match(app, /channel\.tokens/);
  assert.match(app, /data-cost-distribution/);
  assert.match(html, /data-cost-distribution="channel"/);
  assert.doesNotMatch(html, /data-cost-distribution="model"/);
  assert.match(html, /data-cost-distribution="model-test"/);
  assert.match(app, /state\.overview\?\.modelTests/);
  assert.match(html, />渠道成本分布</);
});

test('aligns cost distribution columns without stretching the name column', async () => {
  const css = await readFile(cssPath, 'utf8');

  assert.match(css, /\.model-row \{[^}]*grid-template-columns: clamp\(170px, 20%, 220px\) minmax\(120px, 1fr\) 300px;/);
  assert.match(css, /\.model-values \{[^}]*grid-template-columns: 92px minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 1100px\)[\s\S]*?\.model-row \{[^}]*grid-template-areas: "name values" "track track";/);
});

test('uses the available desktop width, larger text, and an unclipped overflow tooltip', async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
  ]);

  assert.match(css, /\.content-wrap \{[^}]*width: calc\(100% - 24px\);/);
  assert.doesNotMatch(css, /min\(1440px/);
  assert.match(css, /body \{[^}]*font: 15px\/1\.55/);
  assert.match(css, /\.data-table \{[^}]*font-size: 14px;/);
  assert.match(app, /target\.scrollWidth <= target\.clientWidth/);
  assert.match(app, /document\.body\.append\(tooltip\)/);
  assert.match(app, /enableOverflowTooltip\(note\)/);
  assert.match(css, /\.floating-tooltip \{[^}]*position: fixed;[^}]*z-index: 80;/);
});

test('renders sanitized wallet balances and keeps credentials inside the settings dialog', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(html, />上游余额</);
  assert.match(html, /id="wallet-refresh-all"/);
  assert.match(html, /id="channel-settings-dialog"/);
  assert.match(html, /id="channel-settings-config-tab"/);
  assert.match(html, /id="channel-settings-wallet-tab"/);
  assert.match(html, /id="settings-wallet-credential" type="password" autocomplete="new-password"/);
  assert.match(app, /wallet\.balance === null \|\| wallet\.balance === undefined/);
  assert.match(app, /wallet\.adapter === 'auto' && detectedCredentialAdapter/);
  assert.match(app, /粘贴 Sub2 refresh token/);
  assert.match(app, /authorize\.textContent = wallet\.status === 'needs_reauth' \? '重新授权' : '授权'/);
  assert.match(app, /edge_blocked: '被上游 Cloudflare\/WAF 拦截'/);
  assert.match(app, /walletStatusDetail\(wallet/);
  assert.match(app, /if \(wallet\.adapter === 'none'\) return '不检测'/);
  assert.match(app, /设置已保存，但\$\{walletStatusDetail\(wallet\)\}/);
  assert.match(app, /openChannelSettings\(channel, 'wallet'/);
  assert.match(app, /clearWalletCredentialInput\(\)/);
  assert.doesNotMatch(app, /walletEditor|editing-row|editingChannelId/);
  assert.match(css, /\.wallet-summary strong \{[^}]*color: var\(--money\);/);
  assert.match(css, /\.channel-settings-dialog \{[^}]*width: min\(700px/);
  assert.doesNotMatch(app, /wallet\.credential/);
});

test('edits and refreshes models in the channel settings dialog without touching token allowlists', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(app, /modelsText: channel\.models\.join\(', '\)/);
  assert.match(app, /\/api\/channels\/\$\{channel\.id\}\/models/);
  assert.match(app, /cell\(modelPills\(channel\.models\)/);
  assert.match(app, /models,\s*testModel: draft\.testModel/);
  assert.match(html, /id="settings-models"/);
  assert.match(css, /\.settings-group textarea/);
  assert.doesNotMatch(css, /\.editing-row/);
  assert.doesNotMatch(app, /model_limits|allowlist|白名单/);
});

test('shows a per-channel manual refresh for automatically synchronized cost multipliers', async () => {
  const [app, css] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
  ]);

  assert.match(app, /sync\.mode === 'auto'/);
  assert.match(app, /className = 'cost-sync-refresh'/);
  assert.match(app, /\/api\/channels\/\$\{channel\.id\}\/cost-sync/);
  assert.match(app, /立即同步 \$\{channel\.name\} 上游倍率/);
  assert.match(app, /一分钟内已探测过/);
  assert.match(app, /probe_rate_limited/);
  assert.doesNotMatch(app, /待再次验证|两次倍率结果不一致/);
  assert.doesNotMatch(app, /待人工确认|异常变更/);
  assert.doesNotMatch(app, /pricingRemanage|model-pricing-sync\/remanage|manual_override|mutation_blocked/);
  assert.doesNotMatch(css, /pricing-sync-manual_override|pricing-sync-mutation_blocked/);
  assert.match(css, /\.cost-sync-refresh, \.wallet-refresh/);
});

test('surfaces production failures in the alert and request timeline', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(html, /id="upstream-alert"/);
  assert.match(html, /id="status-filter"/);
  assert.match(html, />仅失败</);
  assert.match(html, />Token 明细 \/ 错误</);
  assert.match(app, /log\.kind === 'error'/);
  assert.match(app, /metrics\.failedRequests/);
  assert.match(css, /\.request-error-row/);
  assert.match(css, /\.status-failing/);
  assert.match(css, /\.status-recovered/);
});

test('shows automatic upstream probe availability instead of production traffic results', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(html, /上游渠道自动探活/);
  assert.match(html, />自动探活</);
  assert.match(app, /channel\.probeSuccessRate/);
  assert.match(app, /channel\.probeSuccesses/);
  assert.match(app, /channel\.recentProbes/);
  assert.match(app, /结果独立于真实业务请求/);
  assert.doesNotMatch(app, /暂无真实请求/);
  assert.doesNotMatch(app, /基于该渠道真实上游请求计算/);
  assert.doesNotMatch(app, /test\.textContent = '检测'/);
  assert.doesNotMatch(app, /poolTrafficShare/);
  assert.match(css, /\.availability-strip/);
  assert.match(css, /\.availability-event-success/);
  assert.match(css, /\.availability-event-error/);
});

test('lets the operator persist the automatic probe interval from the channel panel', async () => {
  const [app, html, server] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /id="channel-health-settings-button"/);
  assert.match(html, /id="channel-health-settings-form"/);
  assert.match(html, /id="channel-health-interval" type="number" min="1" max="1440"/);
  assert.match(app, /async function saveChannelHealthSettings/);
  assert.match(app, /api\('\/api\/settings\/probes'/);
  assert.match(app, /每 \$\{settings\.probeIntervalMinutes\} 分钟探活/);
  assert.match(server, /url\.pathname === '\/api\/settings\/probes'/);
});

test('offers calendar-day statistics alongside rolling periods', async () => {
  const [app, css, html, server] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
    readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /data-period="today" class="active">今天/);
  assert.match(html, /data-period="yesterday">昨天/);
  assert.match(html, /data-period="hours-24">24 小时/);
  assert.match(app, /periodKey: 'today'/);
  assert.match(html, /data-period="hours-168">7 天/);
  assert.match(html, /data-period="hours-720">30 天/);
  assert.match(css, /\.period-control \{ display: grid; grid-template-columns: repeat\(7,/);
  assert.match(app, /const periodDefinitions = Object\.freeze/);
  assert.match(app, /period: 'today'/);
  assert.match(app, /period: 'yesterday'/);
  assert.match(app, /periodQuery\(requestedPeriodKey\)/);
  const nowMs = Date.parse('2026-10-27T04:00:00Z');
  assert.equal(resolvePeriod({ period: 'today', nowMs }).startTimestamp, Date.parse('2026-10-26T16:00:00Z') / 1000);
  assert.equal(resolvePeriod({ period: 'yesterday', nowMs }).endTimestamp, Date.parse('2026-10-26T16:00:00Z') / 1000);
  assert.match(server, /url\.searchParams\.get\('period'\)/);
});

test('offers one-click primary routing without hiding advanced priority settings', async () => {
  const [app, css, html] = await Promise.all([
    readFile(appPath, 'utf8'),
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  assert.match(app, /channel\.isSolePrimary/);
  assert.match(app, /'设为唯一主用' : '设为主用'/);
  assert.match(app, /\/api\/channels\/\$\{channel\.id\}\/primary/);
  assert.match(app, /channel\.state === 'failing'/);
  assert.match(css, /\.route-primary-action/);
  assert.match(css, /\.route-state-line \{[^}]*flex-wrap: wrap;/);
  assert.match(html, /id="routing-confirm-dialog"/);
  assert.match(html, /id="settings-priority"/);
});
