package contract

import (
	"encoding/json"
	"errors"
	"math/big"
	"net/url"
	"strings"
	"time"
)

// wildcardElement mirrors configview.WildcardModel; this package must not import gateway business code.
const wildcardElement = "*"

type wildcardKind int

const (
	wildcardNone  wildcardKind = iota // no "*" in the list
	wildcardOnly                      // exactly ["*"]
	wildcardMixed                     // "*" next to other ids: rejected
)

// wildcardKindOf classifies a permission list (model_ids, channel_ids or protocols).
func wildcardKindOf(list []interface{}) wildcardKind {
	for _, item := range list {
		if text(item) == wildcardElement {
			if len(list) == 1 {
				return wildcardOnly
			}
			return wildcardMixed
		}
	}
	return wildcardNone
}

func object(value interface{}) map[string]interface{} { return value.(map[string]interface{}) }
func rows(value interface{}) []interface{}            { return value.([]interface{}) }
func text(value interface{}) string {
	if value == nil {
		return ""
	}
	return value.(string)
}
func integer(value interface{}) *big.Int {
	if value == nil {
		return nil
	}
	raw := value.(json.Number).String()
	// Decoded counts overwhelmingly use ordinary decimal integers. Preserve exact
	// exponent/fraction handling below without allocating a rational for that path.
	if result, ok := new(big.Int).SetString(raw, 10); ok {
		return result
	}
	rational, ok := new(big.Rat).SetString(raw)
	if !ok || !rational.IsInt() {
		panic("schema accepted non-integer")
	}
	return new(big.Int).Set(rational.Num())
}
func same(a, b interface{}) bool            { return a == b }
func countValue(value interface{}) *big.Int { return integer(object(value)["value"]) }
func contains(items []interface{}, wanted string) bool {
	for _, item := range items {
		if text(item) == wanted {
			return true
		}
	}
	return false
}

func channelPools(channel map[string]interface{}) []interface{} {
	if pools, ok := channel["pool_ids"]; ok {
		return rows(pools)
	}
	return []interface{}{channel["pool_id"]}
}

func (v *Validator) ValidateUsage(data []byte, read bool) error {
	value, err := v.validate("usage", data, read)
	if err != nil {
		return err
	}
	return usageRelations(object(value))
}

func usageRelations(usage map[string]interface{}) error {
	writes := object(usage["cache_write"])
	counts := []interface{}{usage["total_input"], usage["input_uncached"], usage["cache_read"], usage["output_total"], usage["reasoning"], writes["ttl_5m"], writes["ttl_1h"], writes["ttl_unknown"]}
	for _, item := range counts {
		count := object(item)
		availability, provenance := text(count["availability"]), text(count["provenance"])
		if (availability == "absent") != (count["value"] == nil) || (provenance == "absent") != (availability == "absent") || (availability == "known" && provenance == "adapter_estimate") || (availability == "estimated" && provenance == "provider") {
			return errors.New("count_availability_mismatch")
		}
	}
	total := countValue(usage["total_input"])
	input := []interface{}{usage["input_uncached"], usage["cache_read"], writes["ttl_5m"], writes["ttl_1h"], writes["ttl_unknown"]}
	sum, complete := new(big.Int), true
	for _, item := range input {
		if value := countValue(item); value != nil {
			sum.Add(sum, value)
		} else {
			complete = false
		}
	}
	if total != nil && complete && total.Cmp(sum) != 0 {
		return errors.New("input_breakdown_mismatch")
	}
	cacheSum, cachesKnown := new(big.Int), true
	for _, item := range input[1:] {
		if value := countValue(item); value != nil {
			cacheSum.Add(cacheSum, value)
		} else {
			cachesKnown = false
		}
	}
	if total != nil && cachesKnown && cacheSum.Cmp(total) > 0 && (countValue(usage["input_uncached"]) != nil || !contains(rows(usage["issues"]), "cache_exceeds_input")) {
		return errors.New("cache_contradiction_unmarked")
	}
	reasoning, output := countValue(usage["reasoning"]), countValue(usage["output_total"])
	if text(usage["reasoning_relation"]) == "subset_of_output" && reasoning != nil && output != nil && reasoning.Cmp(output) > 0 {
		return errors.New("reasoning_exceeds_output")
	}
	provider := text(usage["provider"])
	for key := range object(usage["provider_counts"]) {
		if provider == "unknown" || !strings.HasPrefix(key, provider+"_") {
			return errors.New("provider_count_mismatch")
		}
	}
	return nil
}

func identities(items []interface{}, key string) (map[string]bool, error) {
	seen := map[string]bool{}
	for _, item := range items {
		identity := text(object(item)[key])
		if seen[identity] {
			return nil, errors.New("duplicate_identity")
		}
		seen[identity] = true
	}
	return seen, nil
}

func targetOrigin(value string) string {
	u, _ := url.Parse(value)
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme+"://"+u.Hostname()) + ":" + port
}

func (v *Validator) ValidateConfig(data, credentialData []byte, forbiddenTargets []string) error {
	value, err := v.validate("config", data, false)
	if err != nil {
		return err
	}
	config := object(value)
	pools, err := identities(rows(config["pools"]), "id")
	if err != nil {
		return err
	}
	models, err := identities(rows(config["models"]), "id")
	if err != nil {
		return err
	}
	if _, err = identities(rows(config["channels"]), "id"); err != nil {
		return err
	}
	if _, err = identities(rows(config["callers"]), "id"); err != nil {
		return err
	}
	callerTokens := map[string]bool{}
	for _, item := range rows(config["callers"]) {
		caller := object(item)
		tokens := []interface{}{caller["token_hmac"]}
		if aliases, ok := caller["token_hmac_aliases"]; ok {
			tokens = append(tokens, rows(aliases)...)
		}
		for _, token := range tokens {
			value := text(token)
			if callerTokens[value] {
				return errors.New("duplicate_identity")
			}
			callerTokens[value] = true
		}
	}
	channels := map[string]map[string]interface{}{}
	for _, item := range rows(config["channels"]) {
		channel := object(item)
		channels[text(channel["id"])] = channel
		if !pools[text(channel["pool_id"])] {
			return errors.New("unknown_pool")
		}
		if !contains(channelPools(channel), text(channel["pool_id"])) {
			return errors.New("primary_pool_missing")
		}
		for _, pool := range channelPools(channel) {
			if !pools[text(pool)] {
				return errors.New("unknown_pool")
			}
		}
		if priorities, ok := channel["pool_priorities"]; ok {
			for pool := range object(priorities) {
				if !contains(channelPools(channel), pool) {
					return errors.New("priority_pool_outside_membership")
				}
			}
		}
		if _, err := identities(rows(channel["models"]), "model_id"); err != nil {
			return err
		}
		for _, model := range rows(channel["models"]) {
			if !models[text(object(model)["model_id"])] {
				return errors.New("unknown_model")
			}
		}
		if (channel["credential_ref"] == nil) != (channel["credential_version"] == nil) || (channel["enabled"] == true && channel["credential_ref"] == nil) {
			return errors.New("credential_state_invalid")
		}
		for _, target := range forbiddenTargets {
			if !isHTTPURL(target) {
				return errors.New("invalid_forbidden_target")
			}
			if targetOrigin(text(channel["base_url"])) == targetOrigin(target) {
				return errors.New("loop_target")
			}
		}
	}
	aliases := map[string]bool{}
	for _, item := range rows(config["aliases"]) {
		alias := object(item)
		key := text(alias["pool_id"]) + "\x00" + text(alias["alias"])
		if aliases[key] || models[text(alias["alias"])] {
			return errors.New("alias_collision")
		}
		aliases[key] = true
		if !pools[text(alias["pool_id"])] || !models[text(alias["model_id"])] {
			return errors.New("unknown_alias_target")
		}
	}
	for _, item := range rows(config["callers"]) {
		for _, raw := range rows(object(item)["permissions"]) {
			permission := object(raw)
			if !pools[text(permission["pool_id"])] {
				return errors.New("unknown_permission_pool")
			}
			// "*" in model_ids, channel_ids or protocols grants everything that list can name and is valid only as
			// the sole element of that list.
			modelIDs, channelIDs, protocols := rows(permission["model_ids"]), rows(permission["channel_ids"]), rows(permission["protocols"])
			modelKind, channelKind, protocolKind := wildcardKindOf(modelIDs), wildcardKindOf(channelIDs), wildcardKindOf(protocols)
			if modelKind == wildcardMixed || channelKind == wildcardMixed || protocolKind == wildcardMixed {
				return errors.New("permission_wildcard_mixed")
			}
			for _, model := range modelIDs {
				if modelKind == wildcardNone && !models[text(model)] {
					return errors.New("unknown_permission_model")
				}
			}
			for _, channelID := range channelIDs {
				channel := channels[text(channelID)]
				if channelKind == wildcardNone && (channel == nil || !contains(channelPools(channel), text(permission["pool_id"]))) {
					return errors.New("permission_channel_outside_pool")
				}
			}
		}
	}
	if credentialData != nil {
		value, err := v.validate("credentials", credentialData, false)
		if err != nil {
			return err
		}
		credentials := object(value)
		if !same(credentials["gen"], config["gen"]) {
			return errors.New("credential_generation_mismatch")
		}
		refs := map[string]bool{}
		for _, raw := range rows(credentials["entries"]) {
			entry := object(raw)
			key := text(entry["credential_ref"]) + "\x00" + text(entry["credential_version"])
			if refs[key] {
				return errors.New("duplicate_credential")
			}
			refs[key] = true
		}
		for _, channel := range channels {
			if channel["credential_ref"] != nil && !refs[text(channel["credential_ref"])+"\x00"+text(channel["credential_version"])] {
				return errors.New("credential_reference_missing")
			}
		}
	}
	return nil
}

func (v *Validator) ValidateRecord(name string, data []byte, read bool) error {
	if name != "attempt" && name != "event" {
		return errors.New("invalid record contract")
	}
	value, err := v.validate(name, data, read)
	if err != nil {
		return err
	}
	return recordRelations(name, object(value), read)
}

// ValidatePage validates the complete nested schema once, then applies the same
// record relations to those decoded values without re-decoding each record.
func (v *Validator) ValidatePage(name string, data []byte) error {
	if name != "attempts_page" && name != "events_page" {
		return errors.New("invalid page contract")
	}
	value, err := v.validate(name, data, true)
	if err != nil {
		return err
	}
	return v.ValidatePageValue(name, value)
}

func recordRelations(name string, attempt map[string]interface{}, read bool) error {
	if name == "event" {
		attempt = object(attempt["attempt"])
	}
	intent, terminal := object(attempt["intent"]), object(attempt["terminal"])
	if err := usageRelations(object(terminal["usage"])); err != nil {
		return err
	}
	if !same(intent["attempt_id"], terminal["attempt_id"]) {
		return errors.New("attempt_identity_mismatch")
	}
	start, _ := time.Parse(time.RFC3339Nano, text(intent["started_at"]))
	end, _ := time.Parse(time.RFC3339Nano, text(terminal["ended_at"]))
	if end.Before(start) {
		return errors.New("terminal_before_intent")
	}
	if ttft := integer(terminal["ttft_ms"]); ttft != nil && ttft.Cmp(integer(terminal["duration_ms"])) > 0 {
		return errors.New("ttft_exceeds_duration")
	}
	if text(terminal["attempt_outcome"]) == "succeeded" {
		status := integer(terminal["upstream_status"])
		protocol := text(terminal["protocol_terminal"])
		stream := intent["stream"] == true
		validProtocol := protocol == "completed" || (!stream && protocol == "not_applicable")
		validStatus := status != nil && status.Int64() >= 200 && status.Int64() <= 299
		// Read compatibility for the early candidate's local tokenizer records.
		// New local count_tokens calls do not create upstream attempts.
		localCount := read && !stream && text(intent["protocol"]) == "count_tokens" && status == nil &&
			text(terminal["send_certainty"]) == "none" && protocol == "not_applicable"
		if text(terminal["request_outcome"]) != "succeeded" || terminal["error_class"] != nil || !validProtocol || (!validStatus && !localCount) {
			return errors.New("success_semantics_mismatch")
		}
	} else if text(terminal["request_outcome"]) == "succeeded" {
		return errors.New("success_semantics_mismatch")
	}
	if text(terminal["attempt_outcome"]) == "not_sent" && text(terminal["send_certainty"]) != "none" {
		return errors.New("not_sent_semantics_mismatch")
	}
	return nil
}

func (v *Validator) ValidateQuery(name string, data []byte) error {
	if name != "attempts_query" && name != "stats_query" {
		return errors.New("invalid query contract")
	}
	value, err := v.validate(name, data, false)
	if err != nil {
		return err
	}
	query := object(value)
	from, _ := time.Parse(time.RFC3339Nano, text(query["from"]))
	to, _ := time.Parse(time.RFC3339Nano, text(query["to"]))
	if !from.Before(to) {
		return errors.New("empty_or_reversed_interval")
	}
	if name == "attempts_query" && query["cursor"] != nil && query["snapshot_seq"] == nil {
		return errors.New("cursor_requires_snapshot")
	}
	return nil
}
