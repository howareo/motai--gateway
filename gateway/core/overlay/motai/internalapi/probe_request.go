package internalapi

import (
	"encoding/json"
	"net/http"
	"strings"
)

// probeRequest builds the request a channel probe sends through the relay. It follows New API's channel test
// (controller/channel-test.go buildTestRequest): synchronous and never streaming, a one-word prompt, a small output budget.
// The responses body carries no output cap, like New API: a cap of a few tokens makes upstreams answer status "incomplete",
// which the core records as a failed probe. Gemini gets New API's larger budget so thinking models still return a candidate.
func probeRequest(protocol, modelID, sessionID string) (string, map[string]any) {
	chat := map[string]any{"model": modelID, "stream": false, "max_tokens": 16, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	switch protocol {
	case "responses":
		return "/v1/responses", map[string]any{"model": modelID, "stream": false, "input": []any{map[string]any{"role": "user", "content": "hi"}}}
	case "messages":
		if strings.HasPrefix(modelID, "claude-") {
			// Keep the synthetic health check compatible with Claude Code-only relays.
			chat["max_tokens"] = 1
			chat["system"] = []any{map[string]any{"type": "text", "text": "You are Claude Code, Anthropic's official CLI for Claude."}}
			userID, _ := json.Marshal(map[string]string{"device_id": strings.Repeat("0", 64), "account_uuid": "", "session_id": sessionID})
			chat["metadata"] = map[string]any{"user_id": string(userID)}
		}
		return "/v1/messages", chat
	case "gemini_generate_content":
		return "/v1beta/models/" + modelID + ":generateContent", map[string]any{
			"contents":         []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hi"}}}},
			"generationConfig": map[string]any{"maxOutputTokens": 3000},
		}
	}
	return "/v1/chat/completions", chat
}

func applyProbeRequestHeaders(request *http.Request, protocol, modelID, sessionID string) {
	if protocol != "messages" || !strings.HasPrefix(modelID, "claude-") {
		return
	}
	request.Header.Set("User-Agent", "claude-cli/2.1.322 (external, cli)")
	request.Header.Set("X-App", "cli")
	request.Header.Set("Anthropic-Beta", "claude-code-20250219")
	request.Header.Set("Anthropic-Version", "2023-06-01")
	request.Header.Set("X-Claude-Code-Session-Id", sessionID)
}
