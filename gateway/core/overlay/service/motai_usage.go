package service

import (
	"github.com/QuantumNous/new-api/motai/nocharge"
	"github.com/QuantumNous/new-api/motai/usage"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
)

func installMotaiNoCharge(info *relaycommon.RelayInfo) *nocharge.Session {
	if session, ok := info.Billing.(*nocharge.Session); ok {
		return session
	}
	session := &nocharge.Session{}
	info.Billing = session
	info.FinalPreConsumedQuota = 0
	return session
}

// ObserveMotaiUsage runs immediately after the existing adaptor, including its error return.
func ObserveMotaiUsage(ctx *gin.Context, info *relaycommon.RelayInfo, extracted any, failed bool) {
	if !nocharge.Enabled() || info == nil {
		return
	}
	origin, _ := extracted.(*dto.Usage)
	counts := map[string]int64{}
	provider := "unknown"
	put := func(key string, value int) {
		// shortcut: legacy scalar DTOs lose field presence; ambiguous zeros stay absent until adaptors expose presence.
		if value != 0 {
			counts[key] = int64(value)
		}
	}
	// present records a value the provider's standard usage structure always carries, so 0 is kept, but a 0 never
	// replaces a count that an earlier source already set.
	present := func(key string, value int) {
		if _, seen := counts[key]; seen && value == 0 {
			return
		}
		counts[key] = int64(value)
	}
	if origin != nil {
		observed := origin.BillingUsage
		if observed != nil && observed.ClaudeUsage != nil {
			provider = "anthropic"
			u := observed.ClaudeUsage
			if u.InputTokens != 0 || u.OutputTokens != 0 || u.CacheReadInputTokens != 0 || u.CacheCreationInputTokens != 0 {
				// Anthropic's usage object always carries these four keys, and a cache field that is 0 means "no cache traffic".
				// Normalize needs input, cache read and cache creation together to derive TotalInput, so a 0 must be kept here.
				// A usage object that is zero everywhere is an unreported one and stays absent (usage_missing).
				present("anthropic_input_tokens", u.InputTokens)
				present("anthropic_output_tokens", u.OutputTokens)
				present("anthropic_cache_read_input_tokens", u.CacheReadInputTokens)
				present("anthropic_cache_creation_input_tokens", u.CacheCreationInputTokens)
			}
			put("anthropic_cache_creation_5m_tokens", u.GetCacheCreation5mTokens())
			put("anthropic_cache_creation_1h_tokens", u.GetCacheCreation1hTokens())
		} else if observed != nil && observed.GeminiUsageMetadata != nil {
			provider = "gemini"
			u := observed.GeminiUsageMetadata
			put("gemini_prompt_token_count", u.PromptTokenCount)
			put("gemini_thoughts_token_count", u.ThoughtsTokenCount)
			put("gemini_total_token_count", u.TotalTokenCount)
			if u.PromptTokenCount != 0 {
				// Gemini usageMetadata is proto3 JSON, which omits default values: a missing candidatesTokenCount or
				// cachedContentTokenCount in a response that reports promptTokenCount means 0, not "unknown".
				present("gemini_candidates_token_count", u.CandidatesTokenCount)
				present("gemini_cached_content_token_count", u.CachedContentTokenCount)
			} else {
				put("gemini_candidates_token_count", u.CandidatesTokenCount)
				put("gemini_cached_content_token_count", u.CachedContentTokenCount)
			}
		} else {
			provider = "openai"
			u := origin
			if observed != nil && observed.OpenAIUsage != nil {
				u = observed.OpenAIUsage
			}
			put("openai_input_tokens", u.PromptTokens)
			put("openai_output_tokens", u.CompletionTokens)
			put("openai_cached_tokens", u.PromptTokensDetails.CachedTokens)
			if u.InputTokensDetails != nil {
				// A non-nil input_tokens_details is evidence the upstream reported the cache field, so 0 is a real 0.
				// Chat-completions prompt_tokens_details is a plain struct here and cannot show presence; its 0 stays absent.
				present("openai_cached_tokens", u.InputTokensDetails.CachedTokens)
			}
			put("openai_reasoning_tokens", u.CompletionTokenDetails.ReasoningTokens)
		}
	}
	partial := failed || info.StreamStatus.HasErrors() || (info.IsStream && !info.StreamStatus.IsNormalEnd())
	if ctx != nil && ctx.Request != nil && ctx.Request.Context().Err() != nil {
		partial = true
	}
	normalized := usage.Normalize(provider, counts, partial)
	session := installMotaiNoCharge(info)
	// A later error with no usage must not erase previously observed numeric fields.
	if origin != nil || session.Usage == nil {
		session.Usage = &normalized
	}
}
