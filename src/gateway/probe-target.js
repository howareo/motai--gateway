// Which model and protocol a channel probe uses. Same rule as New API: an empty test model means the channel's first model.
// Here "first" is the first selected model that a probe can call.
//
// The protocol is chosen like New API's default channel test, which sends a plain non-streaming chat completion:
// Claude uses its native messages protocol when available; other models prefer chat_completions,
// then messages, responses, gemini_generate_content. count_tokens is never probed.
// (responses is a poor probe: a tiny output budget makes some upstreams answer status "incomplete", which the core records as a failure.)
export const PROBE_PROTOCOL_ORDER = Object.freeze(['chat_completions', 'messages', 'responses', 'gemini_generate_content']);

export const probeProtocol = (model) => {
  const capabilities = model?.capabilities ?? [];
  if (model?.modelId?.startsWith('claude-') && capabilities.includes('messages')) return 'messages';
  return PROBE_PROTOCOL_ORDER.find((protocol) => capabilities.includes(protocol)) ?? null;
};

// Returns { modelId, protocol, explicit } or null when the channel has nothing a probe can call.
// An explicit test model is never replaced: if it has no callable protocol the channel has no target.
export function probeTarget(channel) {
  const models = channel?.models ?? [];
  if (channel?.testModel) {
    const protocol = probeProtocol(models.find((row) => row.modelId === channel.testModel));
    return protocol ? { modelId: channel.testModel, protocol, explicit: true } : null;
  }
  for (const model of models) {
    const protocol = probeProtocol(model);
    if (protocol) return { modelId: model.modelId, protocol, explicit: false };
  }
  return null;
}
