package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSharedUsageVectors(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	require.NotEmpty(t, root, "set MOTAI_CONTRACTS_DIR to the shared contracts directory")
	data, err := os.ReadFile(filepath.Join(root, "fixtures", "usage-vectors.json"))
	require.NoError(t, err)
	var fixture struct {
		Vectors []struct {
			ID       string           `json:"id"`
			Provider string           `json:"provider"`
			Counts   map[string]int64 `json:"provider_counts"`
			Partial  bool             `json:"partial"`
			Expected Record           `json:"expected"`
		} `json:"vectors"`
	}
	require.NoError(t, common.Unmarshal(data, &fixture))
	require.NotEmpty(t, fixture.Vectors)
	for _, vector := range fixture.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			assert.Equal(t, vector.Expected, Normalize(vector.Provider, vector.Counts, vector.Partial))
		})
	}
}

func TestInvalidCountersKeepIndependentOutput(t *testing.T) {
	for _, value := range []int64{-1, maxSafeInteger + 1} {
		got := Normalize("openai", map[string]int64{"openai_input_tokens": value, "openai_output_tokens": 7}, true)
		assert.Nil(t, got.TotalInput.Value)
		require.NotNil(t, got.OutputTotal.Value)
		assert.EqualValues(t, 7, *got.OutputTotal.Value)
		assert.Equal(t, "partial", got.OutputTotal.Completeness)
	}
}

func TestContradictoryProviderCountersRemainValidRecords(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	require.NotEmpty(t, root, "set MOTAI_CONTRACTS_DIR to the shared contracts directory")
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	require.NoError(t, err)
	fixture, err := os.ReadFile(filepath.Join(root, "fixtures", "attempt-valid.json"))
	require.NoError(t, err)
	var record map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(fixture, &record))
	var terminal map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(record["terminal"], &terminal))
	for _, test := range []struct {
		name, provider, issue string
		counts                map[string]int64
	}{
		{"reasoning-exceeds-output", "openai", "reasoning_exceeds_output", map[string]int64{"openai_output_tokens": 1, "openai_reasoning_tokens": 2}},
		{"cache-exceeds-input", "deepseek", "cache_exceeds_input", map[string]int64{"deepseek_prompt_tokens": 1, "deepseek_prompt_cache_hit_tokens": 2, "deepseek_prompt_cache_miss_tokens": 0}},
		{"cache-exceeds-input-without-miss", "deepseek", "cache_exceeds_input", map[string]int64{"deepseek_prompt_tokens": 1, "deepseek_prompt_cache_hit_tokens": 2}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := Normalize(test.provider, test.counts, false)
			require.Equal(t, test.counts, got.ProviderCounts, "original observations must survive the contradiction")
			require.Contains(t, got.Issues, test.issue)
			if test.provider == "openai" {
				require.Equal(t, "unknown", got.ReasoningRelation)
				require.NotNil(t, got.OutputTotal.Value)
				require.NotNil(t, got.Reasoning.Value)
				require.EqualValues(t, 1, *got.OutputTotal.Value)
				require.EqualValues(t, 2, *got.Reasoning.Value)
			} else {
				require.Nil(t, got.InputUncached.Value)
				require.NotNil(t, got.TotalInput.Value)
				require.NotNil(t, got.CacheRead.Value)
				require.EqualValues(t, 1, *got.TotalInput.Value)
				require.EqualValues(t, 2, *got.CacheRead.Value)
			}
			data, err := json.Marshal(got)
			require.NoError(t, err)
			require.NoError(t, validator.ValidateUsage(data, false))
			terminal["usage"] = data
			record["terminal"], err = json.Marshal(terminal)
			require.NoError(t, err)
			data, err = json.Marshal(record)
			require.NoError(t, err)
			require.NoError(t, validator.ValidateRecord("attempt", data, false))
		})
	}
}
