package internalapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestProbeRequestIsSynchronousAndNeverStreaming(t *testing.T) {
	for _, protocol := range []string{"chat_completions", "messages", "responses", "gemini_generate_content"} {
		path, body := probeRequest(protocol, "Model/Probe", "")
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("%s: %v", protocol, err)
		}
		if strings.Contains(string(raw), `"stream":true`) || strings.Contains(path, "stream") {
			t.Fatalf("%s probe must not stream: %s %s", protocol, path, raw)
		}
		if protocol != "gemini_generate_content" && body["stream"] != false {
			t.Fatalf("%s probe must say stream=false explicitly, got %v", protocol, body["stream"])
		}
		if strings.Contains(string(raw), "LAB:probe") {
			t.Fatalf("%s probe keeps the old marker prompt: %s", protocol, raw)
		}
	}
}

func TestProbeRequestShapesFollowNewAPIChannelTest(t *testing.T) {
	path, body := probeRequest("chat_completions", "M", "")
	if path != "/v1/chat/completions" || body["model"] != "M" || body["max_tokens"] != 16 {
		t.Fatalf("chat probe: %s %v", path, body)
	}
	if got := body["messages"].([]any)[0].(map[string]any); got["role"] != "user" || got["content"] != "hi" {
		t.Fatalf("chat probe prompt: %v", got)
	}
	path, body = probeRequest("messages", "M", "")
	if path != "/v1/messages" || body["max_tokens"] != 16 || body["stream"] != false {
		t.Fatalf("messages probe: %s %v", path, body)
	}
	path, body = probeRequest("responses", "M", "")
	if path != "/v1/responses" || body["model"] != "M" {
		t.Fatalf("responses probe: %s %v", path, body)
	}
	if _, capped := body["max_output_tokens"]; capped {
		t.Fatalf("responses probe must not cap output (an \"incomplete\" status counts as failure): %v", body)
	}
	if got := body["input"].([]any)[0].(map[string]any); got["role"] != "user" || got["content"] != "hi" {
		t.Fatalf("responses probe prompt: %v", got)
	}
	path, body = probeRequest("gemini_generate_content", "gemini-x", "")
	if path != "/v1beta/models/gemini-x:generateContent" {
		t.Fatalf("gemini probe path: %s", path)
	}
	if body["generationConfig"].(map[string]any)["maxOutputTokens"] != 3000 {
		t.Fatalf("gemini probe budget: %v", body["generationConfig"])
	}
}

func TestProbeRequestDefaultsToChatCompletions(t *testing.T) {
	if path, _ := probeRequest("something-else", "M", ""); path != "/v1/chat/completions" {
		t.Fatalf("unknown protocol path: %s", path)
	}
}

func TestProbeRequestClaudeMessagesUsesSingleTokenHealthCheck(t *testing.T) {
	const sessionID = "f93bdf38-b85f-4cb9-bde8-0958ce8e50c7"
	path, body := probeRequest("messages", "claude-probe", sessionID)
	if path != "/v1/messages" || body["model"] != "claude-probe" || body["max_tokens"] != 1 || body["stream"] != false {
		t.Fatalf("Claude probe: %s %v", path, body)
	}
	if system := body["system"].([]any)[0].(map[string]any); system["type"] != "text" || system["text"] != "You are Claude Code, Anthropic's official CLI for Claude." {
		t.Fatalf("Claude probe system: %v", system)
	}
	var userID map[string]string
	if err := json.Unmarshal([]byte(body["metadata"].(map[string]any)["user_id"].(string)), &userID); err != nil {
		t.Fatal(err)
	}
	if len(userID) != 3 || userID["device_id"] != strings.Repeat("0", 64) || userID["account_uuid"] != "" || userID["session_id"] != sessionID {
		t.Fatalf("Claude probe metadata: %v", userID)
	}
	request := httptest.NewRequest(http.MethodPost, path, nil)
	applyProbeRequestHeaders(request, "messages", "claude-probe", sessionID)
	wantHeaders := map[string]string{"User-Agent": "claude-cli/2.1.322 (external, cli)", "X-App": "cli", "Anthropic-Beta": "claude-code-20250219", "Anthropic-Version": "2023-06-01", "X-Claude-Code-Session-Id": userID["session_id"]}
	if len(request.Header) != len(wantHeaders) {
		t.Fatalf("unexpected probe headers: %v", request.Header)
	}
	for name, value := range wantHeaders {
		if request.Header.Get(name) != value {
			t.Fatalf("probe header %s: %q", name, request.Header.Get(name))
		}
	}
	for _, fixture := range []struct{ protocol, model string }{{"messages", "other-model"}, {"chat_completions", "claude-probe"}} {
		path, body := probeRequest(fixture.protocol, fixture.model, sessionID)
		if body["max_tokens"] != 16 {
			t.Fatalf("non-Claude-Messages budget changed: %s %s %v", fixture.protocol, fixture.model, body)
		}
		if body["system"] != nil || body["metadata"] != nil {
			t.Fatalf("non-Claude-Messages identity added: %s %s", fixture.protocol, fixture.model)
		}
		request := httptest.NewRequest(http.MethodPost, path, nil)
		applyProbeRequestHeaders(request, fixture.protocol, fixture.model, sessionID)
		if len(request.Header) != 0 {
			t.Fatalf("non-Claude-Messages headers added: %s %s %v", fixture.protocol, fixture.model, request.Header)
		}
	}
}
