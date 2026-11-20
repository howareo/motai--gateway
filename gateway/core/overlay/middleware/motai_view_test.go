package middleware

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/motai/attempt"
	relaychannel "github.com/QuantumNous/new-api/relay/channel"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestApplyMotaiCodexTraceHeadersIsExactAndBounded(t *testing.T) {
	for _, fixture := range []struct {
		name, model, protocol, path, promptCacheKey string
		affinityEnabled                             bool
		want                                        bool
	}{
		{"matching Codex Responses rule", "gpt-policy-test", "responses", "/v1/responses", "session-1", true, true},
		{"grok model", "grok-policy-test", "responses", "/v1/responses", "session-1", true, true},
		{"affinity disabled", "gpt-policy-test", "responses", "/v1/responses", "session-1", false, false},
		{"missing prompt cache key", "gpt-policy-test", "responses", "/v1/responses", "", true, false},
		{"wrong protocol", "gpt-policy-test", "chat_completions", "/v1/responses", "session-1", true, false},
		{"wrong model", "claude-policy-test", "responses", "/v1/responses", "session-1", true, false},
		{"path suffix is outside source rule", "gpt-policy-test", "responses", "/v1/responses/extra", "session-1", true, false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			const body = `{"model":"gpt-policy-test","prompt_cache_key":"session-1","input":"hello"}`
			ctx.Request = httptest.NewRequest(http.MethodPost, fixture.path, strings.NewReader(body))
			ctx.Request.Header.Set("Authorization", "Bearer caller-token")
			for index, name := range motaiCodexTraceHeaders {
				ctx.Request.Header.Set(name, fmt.Sprintf("trace-%d", index))
			}
			channel := &model.Channel{}
			assert.Equal(t, fixture.want, applyMotaiCodexTraceHeaders(ctx, channel, fixture.model, fixture.protocol, fixture.promptCacheKey, fixture.affinityEnabled))
			if !fixture.want {
				assert.Nil(t, channel.HeaderOverride)
			} else {
				require.NotNil(t, channel.HeaderOverride)
				var values map[string]string
				require.NoError(t, json.Unmarshal([]byte(*channel.HeaderOverride), &values))
				assert.Len(t, values, len(motaiCodexTraceHeaders))
				for _, name := range motaiCodexTraceHeaders {
					assert.Equal(t, "{client_header:"+name+"}", values[name])
				}
				assert.NotContains(t, values, "Authorization")
				assert.NotContains(t, values, "prompt_cache_key")
			}
			gotBody, err := io.ReadAll(ctx.Request.Body)
			require.NoError(t, err)
			assert.Equal(t, body, string(gotBody), "header selection must not consume or rewrite request body")
		})
	}
}

func TestMotaiCodexTraceHeadersResolveWithoutReplacingUpstreamAuthorization(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	const body = `{"model":"gpt-policy-test","prompt_cache_key":"session-1","input":"hello"}`
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(body))
	ctx.Request.Header.Set("Authorization", "Bearer caller-token")
	for index, name := range motaiCodexTraceHeaders {
		ctx.Request.Header.Set(name, fmt.Sprintf("trace-%d", index))
	}
	channel := &model.Channel{}
	require.True(t, applyMotaiCodexTraceHeaders(ctx, channel, "gpt-policy-test", "responses", "session-1", true))
	require.NotNil(t, channel.HeaderOverride)
	var values map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(*channel.HeaderOverride), &values))
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ApiKey: "UPSTREAM-KEY", HeadersOverride: values}}
	resolved, err := relaychannel.ResolveHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Len(t, resolved, len(motaiCodexTraceHeaders))
	for index, name := range motaiCodexTraceHeaders {
		assert.Equal(t, fmt.Sprintf("trace-%d", index), resolved[strings.ToLower(name)])
	}
	assert.NotContains(t, resolved, "authorization")
	assert.NotContains(t, resolved, "x-api-key")
	upstreamRequest := httptest.NewRequest(http.MethodPost, "http://upstream.test/v1/responses", nil)
	upstreamRequest.Header.Set("Authorization", "Bearer UPSTREAM-KEY")
	for name, value := range resolved {
		upstreamRequest.Header.Set(name, value)
	}
	assert.Equal(t, "Bearer UPSTREAM-KEY", upstreamRequest.Header.Get("Authorization"), "trace overrides must not replace adapter credentials")
	gotBody, err := io.ReadAll(ctx.Request.Body)
	require.NoError(t, err)
	assert.Equal(t, body, string(gotBody), "placeholder resolution must not consume request body")
}

func TestApplyMotaiClaudeTraceHeadersIsExactAndBounded(t *testing.T) {
	for _, fixture := range []struct {
		name, model, protocol, path, userID string
		want                                bool
	}{
		{"native Claude messages", "claude-policy-test", "messages", "/v1/messages", "user-1", true},
		{"missing user id", "claude-policy-test", "messages", "/v1/messages", "", true},
		{"wrong protocol", "claude-policy-test", "responses", "/v1/messages", "user-1", false},
		{"wrong model", "gpt-policy-test", "messages", "/v1/messages", "user-1", false},
		{"path suffix is outside source rule", "claude-policy-test", "messages", "/v1/messages/count_tokens", "user-1", false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			body := fmt.Sprintf(`{"model":"claude-policy-test","metadata":{"user_id":%q},"messages":[]}`, fixture.userID)
			ctx.Request = httptest.NewRequest(http.MethodPost, fixture.path, strings.NewReader(body))
			ctx.Request.Header.Set("x-api-key", "caller-token")
			channel := &model.Channel{}
			assert.Equal(t, fixture.want, applyMotaiClaudeTraceHeaders(ctx, channel, fixture.model, fixture.protocol))
			if fixture.want {
				require.NotNil(t, channel.HeaderOverride)
			} else {
				assert.Nil(t, channel.HeaderOverride)
			}
			gotBody, err := io.ReadAll(ctx.Request.Body)
			require.NoError(t, err)
			assert.Equal(t, body, string(gotBody), "header selection must not consume or rewrite request body")
		})
	}
	var nilChannelCtx, _ = gin.CreateTestContext(httptest.NewRecorder())
	nilChannelCtx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	assert.False(t, applyMotaiClaudeTraceHeaders(nilChannelCtx, nil, "claude-policy-test", "messages"))
	assert.False(t, applyMotaiClaudeTraceHeaders(nil, &model.Channel{}, "claude-policy-test", "messages"))
}

func TestMotaiClaudeTraceHeadersAreExactlyTheSourceRule(t *testing.T) {
	want := []string{
		"X-Stainless-Arch", "X-Stainless-Lang", "X-Stainless-Os", "X-Stainless-Package-Version",
		"X-Stainless-Retry-Count", "X-Stainless-Runtime", "X-Stainless-Runtime-Version", "X-Stainless-Timeout",
		"User-Agent", "X-App", "Anthropic-Beta", "Anthropic-Dangerous-Direct-Browser-Access", "Anthropic-Version",
		"X-Claude-Code-Session-Id",
	}
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	channel := &model.Channel{}
	require.True(t, applyMotaiClaudeTraceHeaders(ctx, channel, "claude-policy-test", "messages"))
	require.NotNil(t, channel.HeaderOverride)
	var values map[string]string
	require.NoError(t, json.Unmarshal([]byte(*channel.HeaderOverride), &values))
	keys := make([]string, 0, len(values))
	for name, value := range values {
		keys = append(keys, name)
		assert.Equal(t, "{client_header:"+name+"}", value)
	}
	assert.ElementsMatch(t, want, keys)
	assert.NotContains(t, values, "Authorization")
	assert.NotContains(t, values, "X-Api-Key")
}

func TestMotaiClaudeIdentityHeadersResolveWithoutMetadataOrCallerCredentials(t *testing.T) {
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	const body = `{"model":"claude-policy-test","max_tokens":1,"messages":[]}`
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	ctx.Request.Header.Set("Authorization", "Bearer caller-token")
	ctx.Request.Header.Set("X-Api-Key", "caller-key")
	for index, name := range motaiClaudeTraceHeaders {
		ctx.Request.Header.Set(name, fmt.Sprintf("client-%d", index))
	}
	channel := &model.Channel{}
	require.True(t, applyMotaiClaudeTraceHeaders(ctx, channel, "claude-policy-test", "messages"))
	var values map[string]interface{}
	require.NoError(t, json.Unmarshal([]byte(*channel.HeaderOverride), &values))
	info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ApiKey: "UPSTREAM-KEY", HeadersOverride: values}}
	resolved, err := relaychannel.ResolveHeaderOverride(info, ctx)
	require.NoError(t, err)
	require.Len(t, resolved, len(motaiClaudeTraceHeaders))
	upstream := httptest.NewRequest(http.MethodPost, "http://upstream.test/v1/messages", nil)
	upstream.Header.Set("X-Api-Key", "UPSTREAM-KEY")
	for name, value := range resolved {
		upstream.Header.Set(name, value)
	}
	for index, name := range motaiClaudeTraceHeaders {
		assert.Equal(t, fmt.Sprintf("client-%d", index), upstream.Header.Get(name))
	}
	assert.Equal(t, "UPSTREAM-KEY", upstream.Header.Get("X-Api-Key"))
	assert.Empty(t, upstream.Header.Get("Authorization"))
	gotBody, err := io.ReadAll(ctx.Request.Body)
	require.NoError(t, err)
	assert.Equal(t, body, string(gotBody))

	ctx.Request.Header.Del("User-Agent")
	ctx.Request.Header.Del("X-App")
	ctx.Request.Header.Del("X-Claude-Code-Session-Id")
	resolved, err = relaychannel.ResolveHeaderOverride(info, ctx)
	require.NoError(t, err)
	assert.NotContains(t, resolved, "user-agent", "missing client identity must not be synthesized")
	assert.NotContains(t, resolved, "x-app")
	assert.NotContains(t, resolved, "x-claude-code-session-id")
	assert.NotContains(t, resolved, "authorization")
	assert.NotContains(t, resolved, "x-api-key")
}

func TestMotaiGeminiRejectsNonGenerationActionsBeforeAdmission(t *testing.T) {
	for _, path := range []string{"/public:countTokens", "/public:embedContent", "/public:batchEmbedContents", "/public:unknown", "/public", "/:generateContent", "/public:generateContent/extra", "/public:generateContent:extra"} {
		t.Run(path, func(t *testing.T) {
			engine := gin.New()
			downstream := 0
			// Nil manager/runtime make any unintended snapshot/admission call fail the test.
			engine.POST("/v1beta/models/*path", MotaiView(nil, nil, nil, "gemini_generate_content"), func(c *gin.Context) { downstream++; c.Status(200) })
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v1beta/models"+path, strings.NewReader(`{"contents":[]}`)))
			assert.Equal(t, http.StatusBadRequest, response.Code)
			assert.Contains(t, response.Body.String(), "invalid_contract")
			assert.Zero(t, downstream)
			assert.Empty(t, response.Header().Get("X-Motai-Attempt-Id"))
		})
	}
}

func TestMotaiGeminiStreamUsesExactActionOrSSEQuery(t *testing.T) {
	for _, fixture := range []struct {
		path, alt string
		stream    bool
	}{
		{"/public:generateContent", "", false},
		{"/public:streamGenerateContent", "", true},
		{"/public:generateContent", "sse", true},
		{"/public:streamGenerateContent", "sse", true},
		{"/streamGenerateContent-model:generateContent", "", false},
	} {
		stream, err := motaiGeminiStream(fixture.path, fixture.alt)
		require.NoError(t, err)
		assert.Equal(t, fixture.stream, stream)
	}
}

func TestMotaiProtocolMetadataAndBodyPreservation(t *testing.T) {
	for _, fixture := range []struct {
		name, protocol, body string
		effort               *string
		budget               *int64
		stream, geminiStream bool
	}{
		{"chat top-level wins", "chat_completions", `{"model":"public","reasoning_effort":"xhigh","reasoning":{"effort":"low"},"stream":true}`, ptrString("xhigh"), nil, true, false},
		{"chat legacy fallback", "chat_completions", `{"model":"public","reasoning":{"effort":"max"}}`, ptrString("max"), nil, false, false},
		{"chat missing", "chat_completions", `{"model":"public"}`, nil, nil, false, false},
		{"messages", "messages", `{"model":"public","output_config":{"effort":"future-level"},"thinking":{"budget_tokens":1024}}`, ptrString("future-level"), ptrInt64(1024), false, false},
		{"messages missing", "messages", `{"model":"public"}`, nil, nil, false, false},
		{"responses unchanged", "responses", `{"model":"public","reasoning":{"effort":"high"},"stream":true}`, ptrString("high"), nil, true, false},
		{"gemini generate ignores body stream", "gemini_generate_content", `{"contents":[],"stream":true}`, nil, nil, false, false},
		{"gemini stream action", "gemini_generate_content", `{"contents":[],"stream":false,"generationConfig":{"thinkingConfig":{"thinkingBudget":0,"thinkingLevel":"HIGH"}}}`, ptrString("HIGH"), ptrInt64(0), true, true},
		{"gemini alt SSE", "gemini_generate_content", `{"contents":[],"generationConfig":{"thinkingConfig":{"thinkingBudget":2048,"thinkingLevel":"medium"}}}`, ptrString("medium"), ptrInt64(2048), true, true},
		{"gemini automatic budget", "gemini_generate_content", `{"contents":[],"generationConfig":{"thinkingConfig":{"thinkingBudget":-1}}}`, nil, ptrInt64(-1), false, false},
		{"gemini native snake aliases", "gemini_generate_content", `{"contents":[],"generationConfig":{"thinking_config":{"thinking_budget":1024,"thinking_level":"low"}}}`, ptrString("low"), ptrInt64(1024), false, false},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodPost, "/synthetic", strings.NewReader(fixture.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			defer common.CleanupBodyStorage(ctx)
			meta, err := readMotaiMetadata(ctx, fixture.protocol, fixture.geminiStream)
			require.NoError(t, err)
			assert.Equal(t, fixture.effort, meta.Effort)
			assert.Equal(t, fixture.budget, meta.ThinkingBudget)
			assert.Equal(t, fixture.stream, meta.Stream)
			storage, err := common.GetBodyStorage(ctx)
			require.NoError(t, err)
			body, err := storage.Bytes()
			require.NoError(t, err)
			assert.Equal(t, fixture.body, string(body), "metadata extraction preserves all request bytes")
		})
	}
}

func TestMotaiProtocolMetadataRejectsUnsupportedNegativeBudgets(t *testing.T) {
	for _, fixture := range []struct{ protocol, body string }{
		{"gemini_generate_content", `{"contents":[],"generationConfig":{"thinkingConfig":{"thinkingBudget":-2}}}`},
		{"messages", `{"model":"public","thinking":{"budget_tokens":-5}}`},
		{"messages", `{"model":"public","thinking":{"budget_tokens":-1}}`},
		{"chat_completions", `{"model":"public","thinking":{"budget_tokens":-1}}`},
		{"responses", `{"model":"public","thinking":{"budget_tokens":-1}}`},
	} {
		t.Run(fixture.protocol+fixture.body, func(t *testing.T) {
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodPost, "/synthetic", strings.NewReader(fixture.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			defer common.CleanupBodyStorage(ctx)
			_, err := readMotaiMetadata(ctx, fixture.protocol, false)
			require.EqualError(t, err, "invalid_contract")
		})
	}
}

func TestMotaiAdmissionErrorMappingPreservesSchemaRejectionAndServiceFailures(t *testing.T) {
	now := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	for _, fixture := range []struct {
		name             string
		err              error
		status           int
		code, retryAfter string
	}{
		{"invalid intent", attempt.ErrInvalidIntent, 400, "invalid_contract", ""},
		{"wrapped invalid intent", fmt.Errorf("wrapped: %w", attempt.ErrInvalidIntent), 400, "invalid_contract", ""},
		{"draining", fmt.Errorf("wrapped: %w", attempt.ErrDraining), 503, "gateway_draining", "1"},
		{"busy", fmt.Errorf("wrapped: %w", attempt.ErrBusy), 503, "gateway_busy", "1"},
		{"channel", errors.New("channel_temporarily_unavailable"), 503, "channel_temporarily_unavailable", ""},
		{"channel cooldown", &attempt.ChannelUnavailableError{RetryAt: now.Add(60 * time.Second)}, 503, "channel_temporarily_unavailable", "60"},
		{"wrapped channel cooldown", fmt.Errorf("wrapped: %w", &attempt.ChannelUnavailableError{RetryAt: now.Add(1500 * time.Millisecond)}), 503, "channel_temporarily_unavailable", "2"},
		{"subsecond channel cooldown", &attempt.ChannelUnavailableError{RetryAt: now.Add(time.Millisecond)}, 503, "channel_temporarily_unavailable", "1"},
		{"elapsed channel cooldown", &attempt.ChannelUnavailableError{RetryAt: now.Add(-time.Second)}, 503, "channel_temporarily_unavailable", "1"},
		{"channel without recovery time", &attempt.ChannelUnavailableError{}, 503, "channel_temporarily_unavailable", ""},
		{"log", errors.New("gateway_log_unavailable"), 503, "gateway_log_unavailable", ""},
		{"unknown", errors.New("synthetic failure"), 503, "gateway_log_unavailable", ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			status, code, retryAfter := motaiAdmissionError(fixture.err, now)
			assert.Equal(t, fixture.status, status)
			assert.Equal(t, fixture.code, code)
			assert.Equal(t, fixture.retryAfter, retryAfter)
		})
	}
}

func TestMotaiUnavailableChannelMessage(t *testing.T) {
	response := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(response)
	motaiError(c, http.StatusServiceUnavailable, "channel_temporarily_unavailable")
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.JSONEq(t, `{"error":{"code":"channel_temporarily_unavailable","message":"No eligible channel is currently available"}}`, response.Body.String())
}

func ptrString(value string) *string { return &value }
func ptrInt64(value int64) *int64    { return &value }

func TestMotaiJSONGatePreservesBodyAndRejectsBeforeMetadata(t *testing.T) {
	for _, fixture := range []struct {
		body  string
		valid bool
	}{
		{`{"model":"public","input":"hello","reasoning":{"effort":"high"}}`, true},
		{`{"model":"public","Model":"private","input":"hello"}`, false},
		{`{"model":"public","metadata":{"user_id":"a","User_ID":"b"}}`, false},
	} {
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", strings.NewReader(fixture.body))
		ctx.Request.Header.Set("Content-Type", "application/json")
		err := validateMotaiJSON(ctx)
		assert.Equal(t, fixture.valid, err == nil)
		body, readErr := io.ReadAll(ctx.Request.Body)
		require.NoError(t, readErr)
		assert.Equal(t, fixture.body, string(body))
		common.CleanupBodyStorage(ctx)
	}
}
