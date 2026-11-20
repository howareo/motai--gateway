const POOLS = Object.freeze({
  openai: Object.freeze({ routingPool: 'openai', routingPoolLabel: 'OpenAI', upstreamGroup: 'openai', usageFamily: 'openai' }),
  claude: Object.freeze({ routingPool: 'claude', routingPoolLabel: 'Claude', upstreamGroup: 'claude', usageFamily: 'anthropic' }),
  xai: Object.freeze({ routingPool: 'xai', routingPoolLabel: 'xAI', upstreamGroup: 'openai', usageFamily: 'openai' }),
  deepseek: Object.freeze({ routingPool: 'deepseek', routingPoolLabel: 'DeepSeek', upstreamGroup: 'openai', usageFamily: 'openai' }),
  gemini: Object.freeze({ routingPool: 'gemini', routingPoolLabel: 'Gemini', upstreamGroup: 'openai', usageFamily: 'openai' }),
  moonshot: Object.freeze({ routingPool: 'moonshot', routingPoolLabel: 'Moonshot', upstreamGroup: 'openai', usageFamily: 'openai' }),
  zhipu: Object.freeze({ routingPool: 'zhipu', routingPoolLabel: 'Zhipu', upstreamGroup: 'openai', usageFamily: 'openai' }),
});

const OFFICIAL_PRICE_SOURCES = Object.freeze({
  openai: 'openai',
  anthropic: 'anthropic',
  xai: 'xai',
  deepseek: 'deepseek',
  google: 'google',
  moonshotai: 'moonshot',
  'moonshotai-cn': 'moonshot',
  zai: 'zhipu',
  zhipuai: 'zhipu',
});

const PRICING_FAMILIES = new Set(Object.values(OFFICIAL_PRICE_SOURCES));

const OFFICIAL_PROVIDERS = Object.freeze({
  openai: 'openai',
  anthropic: 'claude',
  xai: 'xai',
  deepseek: 'deepseek',
  google: 'gemini',
  moonshot: 'moonshot',
  zhipu: 'zhipu',
});

const DEFINITIONS = Object.freeze({
  1: definition('OpenAI', 'openai', 'openai'),
  14: definition('Anthropic', 'anthropic', 'claude'),
  24: definition('Gemini', 'google', 'gemini'),
  25: definition('Moonshot', 'moonshot', 'moonshot'),
  26: definition('Zhipu', 'zhipu', 'zhipu'),
  43: definition('DeepSeek', 'deepseek', 'deepseek'),
  48: definition('xAI', 'xai', 'xai'),
});

function definition(name, providerFamily, pool) {
  return Object.freeze({
    name,
    providerFamily,
    ...POOLS[pool],
    pricingFamily: providerFamily,
  });
}

const NAME_TO_TYPE = new Map(Object.entries(DEFINITIONS).flatMap(([type, definition]) => [
  [definition.name.toLowerCase(), Number(type)],
  [definition.providerFamily, Number(type)],
]));

export function channelTypeInfo(type) {
  const numericType = Number(type);
  if (Number.isInteger(numericType) && DEFINITIONS[numericType]) return DEFINITIONS[numericType];
  const namedType = NAME_TO_TYPE.get(String(type || '').trim().toLowerCase());
  return namedType ? DEFINITIONS[namedType] : null;
}

export function channelTypeName(type) {
  return channelTypeInfo(type)?.name || `Type ${type}`;
}

export function supportedChannelType(type) {
  return Boolean(channelTypeInfo(type));
}

export function officialProviderForPool(pool) {
  return Object.entries(OFFICIAL_PROVIDERS).find(([, mappedPool]) => mappedPool === pool)?.[0] || null;
}

export function pricingSource(providerId) {
  return OFFICIAL_PRICE_SOURCES[providerId] || null;
}

export function pricingProvider(family) {
  return PRICING_FAMILIES.has(family) ? family : null;
}

export function routingPoolLabel(pool) {
  return Object.values(DEFINITIONS).find((definition) => definition.routingPool === pool)?.routingPoolLabel || pool;
}

const MODEL_PROVIDER_RULES = Object.freeze([
  ['claude', (name) => name.includes('claude')],
  ['openai', (name) => /^(gpt|chatgpt|codex|text-embedding|dall-e|whisper|tts)/.test(name) || /^o\d/.test(name)],
  ['gemini', (name) => name.includes('gemini') || name.includes('gemma')],
  ['xai', (name) => name.includes('grok')],
  ['deepseek', (name) => name.includes('deepseek')],
  ['moonshot', (name) => name.includes('kimi') || name.includes('moonshot')],
  ['zhipu', (name) => name.includes('glm') || name.includes('chatglm')],
]);

export function modelProviderPool(models, fallbackPool = null) {
  const counts = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const name = String(model ?? '').trim().toLowerCase();
    const rule = MODEL_PROVIDER_RULES.find(([, match]) => match(name));
    if (rule) counts.set(rule[0], (counts.get(rule[0]) || 0) + 1);
  }
  let best = null;
  for (const [pool, count] of counts) {
    if (best === null || count > counts.get(best)) best = pool;
  }
  return best || fallbackPool;
}

export function channelRoutingPool(channel) {
  const models = String(channel?.models || '').split(',').map((model) => model.trim()).filter(Boolean);
  return modelProviderPool(models, channelTypeInfo(channel?.type)?.routingPool || null);
}

export { DEFINITIONS as CHANNEL_TYPE_DEFINITIONS };
