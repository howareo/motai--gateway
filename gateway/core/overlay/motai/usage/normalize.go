package usage

const maxSafeInteger int64 = 9007199254740991

type Count struct {
	Value        *int64 `json:"value"`
	Availability string `json:"availability"`
	Completeness string `json:"completeness"`
	Provenance   string `json:"provenance"`
}

type CacheWrite struct {
	TTL5m      Count `json:"ttl_5m"`
	TTL1h      Count `json:"ttl_1h"`
	TTLUnknown Count `json:"ttl_unknown"`
}

type Record struct {
	FormatVersion     int              `json:"format_version"`
	NormalizerVersion string           `json:"normalizer_version"`
	Provider          string           `json:"provider"`
	TotalInput        Count            `json:"total_input"`
	InputUncached     Count            `json:"input_uncached"`
	CacheRead         Count            `json:"cache_read"`
	CacheWrite        CacheWrite       `json:"cache_write"`
	OutputTotal       Count            `json:"output_total"`
	Reasoning         Count            `json:"reasoning"`
	ReasoningRelation string           `json:"reasoning_relation"`
	ProviderCounts    map[string]int64 `json:"provider_counts"`
	Issues            []string         `json:"issues"`
}

func (r *Record) issue(issue string) {
	for _, existing := range r.Issues {
		if existing == issue {
			return
		}
	}
	r.Issues = append(r.Issues, issue)
}

func (r *Record) count(value *int64, provenance string) Count {
	result := Count{Value: value, Completeness: r.TotalInput.Completeness, Provenance: provenance, Availability: "known"}
	if value == nil {
		result.Availability, result.Provenance = "absent", "absent"
	}
	return result
}

func (r *Record) read(key string) Count {
	value, ok := r.ProviderCounts[key]
	if !ok {
		return r.count(nil, "absent")
	}
	return r.count(&value, "provider")
}

func (r *Record) derived(value int64) Count { return r.count(&value, "derived") }

// Normalize consumes only presence-aware, numeric adapter observations; it never reads prices or model names.
func Normalize(provider string, counts map[string]int64, partial bool) Record {
	completeness := "final"
	if partial {
		completeness = "partial"
	}
	r := Record{FormatVersion: 1, NormalizerVersion: "1", Provider: provider,
		TotalInput: Count{Completeness: completeness}, ReasoningRelation: "unknown",
		ProviderCounts: map[string]int64{}, Issues: []string{}}
	for key, value := range counts {
		if !allowedCounter(key) {
			continue
		}
		if value < 0 {
			r.issue("counter_invalid")
		} else if value > maxSafeInteger {
			r.issue("counter_overflow")
		} else {
			r.ProviderCounts[key] = value
		}
	}
	r.TotalInput, r.InputUncached, r.CacheRead, r.OutputTotal, r.Reasoning = r.count(nil, "absent"), r.count(nil, "absent"), r.count(nil, "absent"), r.count(nil, "absent"), r.count(nil, "absent")
	r.CacheWrite = CacheWrite{r.count(nil, "absent"), r.count(nil, "absent"), r.count(nil, "absent")}
	switch provider {
	case "openai":
		r.TotalInput, r.OutputTotal = r.read("openai_input_tokens"), r.read("openai_output_tokens")
		r.CacheRead, r.Reasoning = r.read("openai_cached_tokens"), r.read("openai_reasoning_tokens")
		r.ReasoningRelation = "subset_of_output"
		r.CacheWrite = CacheWrite{r.derived(0), r.derived(0), r.derived(0)}
		r.deriveUncached()
		if r.Reasoning.Value != nil && r.OutputTotal.Value != nil && *r.Reasoning.Value > *r.OutputTotal.Value {
			r.ReasoningRelation = "unknown"
			r.issue("reasoning_exceeds_output")
		}
	case "anthropic":
		r.InputUncached, r.OutputTotal = r.read("anthropic_input_tokens"), r.read("anthropic_output_tokens")
		r.CacheRead = r.read("anthropic_cache_read_input_tokens")
		creation := r.read("anthropic_cache_creation_input_tokens")
		if r.InputUncached.Value != nil && r.CacheRead.Value != nil && creation.Value != nil {
			if *r.InputUncached.Value <= maxSafeInteger-*r.CacheRead.Value && *r.InputUncached.Value+*r.CacheRead.Value <= maxSafeInteger-*creation.Value {
				r.TotalInput = r.derived(*r.InputUncached.Value + *r.CacheRead.Value + *creation.Value)
			} else {
				r.issue("counter_overflow")
			}
		}
		five, hour := r.read("anthropic_cache_creation_5m_tokens"), r.read("anthropic_cache_creation_1h_tokens")
		if creation.Value != nil {
			fiveValue, hourValue := int64(0), int64(0)
			if five.Value != nil {
				fiveValue = *five.Value
			}
			if hour.Value != nil {
				hourValue = *hour.Value
			}
			if fiveValue > *creation.Value || hourValue > *creation.Value-fiveValue {
				r.issue("cache_write_breakdown_invalid")
			} else {
				if five.Value == nil {
					five = r.derived(0)
				}
				if hour.Value == nil {
					hour = r.derived(0)
				}
				r.CacheWrite = CacheWrite{five, hour, r.derived(*creation.Value - fiveValue - hourValue)}
			}
		} else {
			r.issue("cache_write_missing")
		}
	case "deepseek":
		r.TotalInput, r.OutputTotal = r.read("deepseek_prompt_tokens"), r.read("deepseek_completion_tokens")
		r.CacheRead, r.InputUncached = r.read("deepseek_prompt_cache_hit_tokens"), r.read("deepseek_prompt_cache_miss_tokens")
		r.CacheWrite = CacheWrite{r.derived(0), r.derived(0), r.derived(0)}
		if r.TotalInput.Value != nil && r.CacheRead.Value != nil && r.InputUncached.Value != nil {
			if *r.CacheRead.Value > *r.TotalInput.Value || *r.InputUncached.Value != *r.TotalInput.Value-*r.CacheRead.Value {
				r.InputUncached = r.count(nil, "absent")
				r.issue("input_breakdown_mismatch")
			}
		}
		if r.TotalInput.Value != nil && r.CacheRead.Value != nil && *r.CacheRead.Value > *r.TotalInput.Value {
			r.InputUncached = r.count(nil, "absent")
			r.issue("cache_exceeds_input")
		}
	case "gemini":
		r.TotalInput, r.OutputTotal = r.read("gemini_prompt_token_count"), r.read("gemini_candidates_token_count")
		r.CacheRead, r.Reasoning = r.read("gemini_cached_content_token_count"), r.read("gemini_thoughts_token_count")
		r.CacheWrite = CacheWrite{r.derived(0), r.derived(0), r.derived(0)}
		r.deriveUncached()
		if r.Reasoning.Value != nil {
			r.issue("reasoning_relation_unknown")
		}
	default:
		r.Provider = "unknown"
		r.issue("provider_semantics_unknown")
	}
	if len(r.ProviderCounts) == 0 {
		r.issue("usage_missing")
	}
	if r.TotalInput.Value == nil && r.InputUncached.Value == nil {
		r.issue("input_missing")
	}
	if r.OutputTotal.Value == nil {
		r.issue("output_missing")
	}
	if r.CacheRead.Value == nil && r.Provider != "unknown" {
		r.issue("cache_read_missing")
	}
	if partial {
		r.issue("usage_partial")
	}
	return r
}

func (r *Record) deriveUncached() {
	if r.TotalInput.Value == nil || r.CacheRead.Value == nil {
		return
	}
	if *r.CacheRead.Value > *r.TotalInput.Value {
		r.issue("cache_exceeds_input")
		return
	}
	r.InputUncached = r.derived(*r.TotalInput.Value - *r.CacheRead.Value)
}

func allowedCounter(key string) bool {
	switch key {
	case "openai_input_tokens", "openai_output_tokens", "openai_cached_tokens", "openai_reasoning_tokens",
		"anthropic_input_tokens", "anthropic_output_tokens", "anthropic_cache_read_input_tokens", "anthropic_cache_creation_input_tokens",
		"anthropic_cache_creation_5m_tokens", "anthropic_cache_creation_1h_tokens", "deepseek_prompt_tokens", "deepseek_completion_tokens",
		"deepseek_prompt_cache_hit_tokens", "deepseek_prompt_cache_miss_tokens", "gemini_prompt_token_count", "gemini_cached_content_token_count",
		"gemini_candidates_token_count", "gemini_thoughts_token_count", "gemini_total_token_count":
		return true
	}
	return false
}
