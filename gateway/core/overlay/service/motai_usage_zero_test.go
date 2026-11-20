package service

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/nocharge"
	"github.com/QuantumNous/new-api/motai/usage"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func observeUsage(t *testing.T, extracted *dto.Usage) usage.Record {
	t.Helper()
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest("POST", "/v1/messages", nil)
	info := &relaycommon.RelayInfo{StartTime: time.Now()}
	ObserveMotaiUsage(ctx, info, extracted, false)
	session, ok := info.Billing.(*nocharge.Session)
	require.True(t, ok)
	require.NotNil(t, session.Usage)
	return *session.Usage
}

func claudeUsage(u dto.ClaudeUsage) *dto.Usage {
	return &dto.Usage{BillingUsage: &dto.BillingUsage{ClaudeUsage: &u}}
}

func value(t *testing.T, count usage.Count) int64 {
	t.Helper()
	require.NotNil(t, count.Value, "expected a known value, got %s", count.Availability)
	return *count.Value
}

func TestMotaiClaudeZeroCacheReadStillDerivesTotalInput(t *testing.T) {
	record := observeUsage(t, claudeUsage(dto.ClaudeUsage{InputTokens: 120, OutputTokens: 9, CacheCreationInputTokens: 300}))
	assert.Equal(t, "anthropic", record.Provider)
	assert.EqualValues(t, 420, value(t, record.TotalInput))
	assert.EqualValues(t, 0, value(t, record.CacheRead))
	assert.EqualValues(t, 300, value(t, record.CacheWrite.TTLUnknown))
	assert.NotContains(t, record.Issues, "cache_read_missing")
}

func TestMotaiClaudeZeroCacheCreationStillDerivesTotalInput(t *testing.T) {
	record := observeUsage(t, claudeUsage(dto.ClaudeUsage{InputTokens: 120, OutputTokens: 9, CacheReadInputTokens: 5000}))
	assert.EqualValues(t, 5120, value(t, record.TotalInput))
	assert.EqualValues(t, 5000, value(t, record.CacheRead))
	assert.EqualValues(t, 0, value(t, record.CacheWrite.TTLUnknown))
	assert.NotContains(t, record.Issues, "cache_write_missing")
}

func TestMotaiClaudeNoCacheTrafficStillDerivesTotalInput(t *testing.T) {
	record := observeUsage(t, claudeUsage(dto.ClaudeUsage{InputTokens: 77, OutputTokens: 4}))
	assert.EqualValues(t, 77, value(t, record.TotalInput))
	assert.EqualValues(t, 0, value(t, record.CacheRead))
}

func TestMotaiClaudeAllZeroUsageStaysUnreported(t *testing.T) {
	record := observeUsage(t, claudeUsage(dto.ClaudeUsage{}))
	assert.Nil(t, record.TotalInput.Value, "an all-zero usage object is not evidence of a zero-token request")
	assert.Contains(t, record.Issues, "usage_missing")
}

func TestMotaiGeminiZeroCachedContentStillDerivesInput(t *testing.T) {
	record := observeUsage(t, &dto.Usage{BillingUsage: &dto.BillingUsage{GeminiUsageMetadata: &dto.GeminiUsageMetadata{
		PromptTokenCount: 900, CandidatesTokenCount: 0, TotalTokenCount: 900}}})
	assert.Equal(t, "gemini", record.Provider)
	assert.EqualValues(t, 900, value(t, record.TotalInput))
	assert.EqualValues(t, 0, value(t, record.CacheRead))
	assert.EqualValues(t, 900, value(t, record.InputUncached))
	assert.EqualValues(t, 0, value(t, record.OutputTotal))
}

func TestMotaiOpenAIResponsesZeroCachedTokensIsKnown(t *testing.T) {
	record := observeUsage(t, &dto.Usage{PromptTokens: 640, CompletionTokens: 12, InputTokensDetails: &dto.InputTokenDetails{}})
	assert.Equal(t, "openai", record.Provider)
	assert.EqualValues(t, 640, value(t, record.TotalInput))
	assert.EqualValues(t, 0, value(t, record.CacheRead))
	assert.EqualValues(t, 640, value(t, record.InputUncached))
}

func TestMotaiOpenAIResponsesNonZeroCachedIsNotOverwrittenByLaterZero(t *testing.T) {
	u := &dto.Usage{PromptTokens: 640, CompletionTokens: 12, InputTokensDetails: &dto.InputTokenDetails{}}
	u.PromptTokensDetails.CachedTokens = 200
	record := observeUsage(t, u)
	assert.EqualValues(t, 200, value(t, record.CacheRead))
	assert.EqualValues(t, 440, value(t, record.InputUncached))
}

// deepseek, xai and moonshot reach the same openai-shaped branch: ObserveMotaiUsage only produces anthropic, gemini or openai.
func TestMotaiOpenAIShapedProvidersDeriveTotalInputWithZeroCache(t *testing.T) {
	for _, provider := range []string{"deepseek", "xai", "moonshot", "openai"} {
		t.Run(provider, func(t *testing.T) {
			record := observeUsage(t, &dto.Usage{PromptTokens: 300, CompletionTokens: 20})
			assert.Equal(t, "openai", record.Provider)
			assert.EqualValues(t, 300, value(t, record.TotalInput))
			assert.EqualValues(t, 20, value(t, record.OutputTotal))
			// A plain prompt_tokens_details cannot show whether cached_tokens was reported, so a 0 stays unknown here.
			assert.Nil(t, record.CacheRead.Value)
			assert.Contains(t, record.Issues, "cache_read_missing")
		})
	}
}
