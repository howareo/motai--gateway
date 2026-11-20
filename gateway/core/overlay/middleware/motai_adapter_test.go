package middleware

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/relay"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	relayconstant "github.com/QuantumNous/new-api/relay/constant"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMotaiChannelTypePreservesExplicitAdapterAndLegacyOmission(t *testing.T) {
	explicit := map[string]int{"openai": constant.ChannelTypeOpenAI, "anthropic": constant.ChannelTypeAnthropic,
		"deepseek": constant.ChannelTypeDeepSeek, "xai": constant.ChannelTypeXai, "gemini": constant.ChannelTypeGemini,
		"moonshot": constant.ChannelTypeMoonshot}
	for adapter, expected := range explicit {
		for _, protocol := range []string{"responses", "chat_completions", "messages", "count_tokens", "gemini_generate_content"} {
			kind, err := motaiChannelType(adapter, protocol)
			require.NoError(t, err)
			require.Equal(t, expected, kind, "%s/%s", adapter, protocol)
		}
	}
	for protocol, expected := range map[string]int{"responses": constant.ChannelTypeOpenAI,
		"chat_completions": constant.ChannelTypeOpenAI, "messages": constant.ChannelTypeAnthropic,
		"count_tokens": constant.ChannelTypeAnthropic, "gemini_generate_content": constant.ChannelTypeGemini} {
		kind, err := motaiChannelType("", protocol)
		require.NoError(t, err)
		require.Equal(t, expected, kind)
	}
	_, err := motaiChannelType("vendor-guess", "messages")
	require.EqualError(t, err, "invalid_contract")
}

// Exercise the selected real core adaptor against a local HTTP receiver. These
// fixtures prove routing/conversion only; they are not live provider evidence.
func TestMotaiExplicitAdapterLocalTransport(t *testing.T) {
	for _, fixture := range []struct {
		name, adapter, protocol, path, wantPath, body, header string
	}{
		{"deepseek messages", "deepseek", "messages", "/v1/messages", "/anthropic/v1/messages", `{"model":"mock-model","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`, "Authorization"},
		{"deepseek responses", "deepseek", "responses", "/v1/responses", "/responses", `{"model":"mock-model","input":"hello"}`, "Authorization"},
		{"deepseek chat", "deepseek", "chat_completions", "/v1/chat/completions", "/v1/chat/completions", `{"model":"mock-model","messages":[{"role":"user","content":"hello"}]}`, "Authorization"},
		{"claude chat conversion", "anthropic", "chat_completions", "/v1/chat/completions", "/v1/messages", `{"model":"mock-model","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`, "X-Api-Key"},
		{"native openai responses", "openai", "responses", "/v1/responses", "/v1/responses", `{"model":"mock-model","input":"hello"}`, "Authorization"},
		{"native claude messages", "anthropic", "messages", "/v1/messages", "/v1/messages", `{"model":"mock-model","max_tokens":16,"messages":[{"role":"user","content":"hello"}]}`, "X-Api-Key"},
		{"native gemini", "gemini", "gemini_generate_content", "/v1beta/models/mock-model:generateContent", "/v1beta/models/mock-model:generateContent", `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`, "X-Goog-Api-Key"},
		{"legacy native gemini", "", "gemini_generate_content", "/v1beta/models/mock-model:generateContent", "/v1beta/models/mock-model:generateContent", `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`, "X-Goog-Api-Key"},
		{"moonshot chat", "moonshot", "chat_completions", "/v1/chat/completions", "/v1/chat/completions", `{"model":"mock-model","messages":[{"role":"user","content":"hello"}]}`, "Authorization"},
		{"xai chat", "xai", "chat_completions", "/v1/chat/completions", "/v1/chat/completions", `{"model":"mock-model","messages":[{"role":"user","content":"hello"}]}`, "Authorization"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			var receivedPath, receivedCredential string
			var receivedBody map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				receivedPath = r.URL.Path
				receivedCredential = r.Header.Get(fixture.header)
				require.NoError(t, json.NewDecoder(r.Body).Decode(&receivedBody))
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer server.Close()
			kind, err := motaiChannelType(fixture.adapter, fixture.protocol)
			require.NoError(t, err)
			apiType, ok := common.ChannelType2APIType(kind)
			require.True(t, ok)
			adaptor := relay.GetAdaptor(apiType)
			require.NotNil(t, adaptor)
			ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx.Request = httptest.NewRequest(http.MethodPost, fixture.path, strings.NewReader(fixture.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			info := &relaycommon.RelayInfo{ChannelMeta: &relaycommon.ChannelMeta{ChannelType: kind, ApiType: apiType,
				ChannelBaseUrl: server.URL, ApiKey: "SYNTHETIC-ADAPTER-KEY", UpstreamModelName: "mock-model"},
				OriginModelName: "mock-model", RequestURLPath: fixture.path, RelayMode: relayconstant.RelayModeChatCompletions}
			var converted any
			switch fixture.protocol {
			case "messages":
				info.RelayFormat = types.RelayFormatClaude
				var request dto.ClaudeRequest
				require.NoError(t, json.Unmarshal([]byte(fixture.body), &request))
				converted, err = adaptor.ConvertClaudeRequest(ctx, info, &request)
			case "responses":
				info.RelayFormat = types.RelayFormatOpenAIResponses
				info.RelayMode = relayconstant.RelayModeResponses
				var request dto.OpenAIResponsesRequest
				require.NoError(t, json.Unmarshal([]byte(fixture.body), &request))
				converted, err = adaptor.ConvertOpenAIResponsesRequest(ctx, info, request)
			case "gemini_generate_content":
				info.RelayFormat = types.RelayFormatGemini
				info.RelayMode = relayconstant.RelayModeGemini
				var request dto.GeminiChatRequest
				require.NoError(t, json.Unmarshal([]byte(fixture.body), &request))
				converted, err = adaptor.ConvertGeminiRequest(ctx, info, &request)
			default:
				info.RelayFormat = types.RelayFormatOpenAI
				var request dto.GeneralOpenAIRequest
				require.NoError(t, json.Unmarshal([]byte(fixture.body), &request))
				converted, err = adaptor.ConvertOpenAIRequest(ctx, info, &request)
				if fixture.adapter == "anthropic" {
					assert.IsType(t, &dto.ClaudeRequest{}, converted)
				}
			}
			require.NoError(t, err)
			body, err := json.Marshal(converted)
			require.NoError(t, err)
			response, err := adaptor.DoRequest(ctx, info, strings.NewReader(string(body)))
			require.NoError(t, err)
			httpResponse, ok := response.(*http.Response)
			require.True(t, ok)
			_, err = io.Copy(io.Discard, httpResponse.Body)
			require.NoError(t, err)
			require.NoError(t, httpResponse.Body.Close())
			require.Equal(t, fixture.wantPath, receivedPath)
			if fixture.header == "Authorization" {
				require.Equal(t, "Bearer SYNTHETIC-ADAPTER-KEY", receivedCredential)
			} else {
				require.Equal(t, "SYNTHETIC-ADAPTER-KEY", receivedCredential)
			}
			if fixture.protocol != "gemini_generate_content" {
				require.Equal(t, "mock-model", receivedBody["model"])
			}
			if fixture.adapter == "anthropic" && fixture.protocol == "chat_completions" {
				require.Equal(t, float64(16), receivedBody["max_tokens"])
				require.NotEmpty(t, receivedBody["messages"])
				require.NotContains(t, receivedBody, "input")
			}
		})
	}
}
