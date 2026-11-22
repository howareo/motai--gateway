package openai

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestMotaiGeminiResponsesExactDefaultIdentity(t *testing.T) {
	if len(geminiDefaultCodexIdentity) != 117 {
		t.Fatal("default identity changed")
	}
	cases := []struct {
		name, template string
		change         bool
	}{
		{"instructions", `{"model":"gemini-test","instructions":IDENTITY,"metadata":{"keep":true}}`, true},
		{"developer string", `{"model":"gemini-test","input":[{"role":"developer","content":IDENTITY}]}`, true},
		{"system string", `{"model":"gemini-test","input":[{"role":"system","content":IDENTITY}]}`, true},
		{"developer part", `{"model":"gemini-test","input":[{"role":"developer","content":[{"type":"input_text","text":IDENTITY,"metadata":{"keep":true}}]}]}`, true},
		{"system part", `{"model":"gemini-test","input":[{"role":"system","content":[{"type":"input_text","text":IDENTITY}]}]}`, true},
		{"user string", `{"model":"gemini-test","input":[{"role":"user","content":IDENTITY}]}`, false},
		{"assistant part", `{"model":"gemini-test","input":[{"role":"assistant","content":[{"type":"input_text","text":IDENTITY}]}]}`, false},
		{"tool result", `{"model":"gemini-test","input":[{"type":"function_call_output","call_id":"keep","output":IDENTITY}]}`, false},
		{"other content type", `{"model":"gemini-test","input":[{"role":"system","content":[{"type":"output_text","text":IDENTITY}]}]}`, false},
		{"input string", `{"model":"gemini-test","input":IDENTITY}`, false},
		{"GPT exact bytes", ` { "model": "gpt-test", "instructions": IDENTITY } `, false},
	}
	texts := []string{geminiDefaultCodexIdentity, " " + geminiDefaultCodexIdentity, geminiDefaultCodexIdentity + "\n", "Before\n" + geminiDefaultCodexIdentity, geminiDefaultCodexIdentity + "\nAfter"}
	for _, tc := range cases {
		for index, text := range texts {
			t.Run(fmt.Sprintf("%s/%d", tc.name, index), func(t *testing.T) {
				encoded, _ := json.Marshal(text)
				input := []byte(strings.ReplaceAll(tc.template, "IDENTITY", string(encoded)))
				got, state, err := prepareGeminiResponses(input)
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(tc.name, "GPT") {
					if state != nil || !bytes.Equal(got, input) {
						t.Fatal("GPT bytes changed")
					}
					return
				}
				want := input
				if tc.change && text == geminiDefaultCodexIdentity {
					replacement, _ := json.Marshal(geminiShortCodexIdentity)
					want = []byte(strings.ReplaceAll(tc.template, "IDENTITY", string(replacement)))
				}
				var actual, expected any
				if err := geminiDecode(got, &actual); err != nil {
					t.Fatal(err)
				}
				if err := geminiDecode(want, &expected); err != nil {
					t.Fatal(err)
				}
				if !reflect.DeepEqual(actual, expected) {
					t.Fatalf("identity scope changed\ngot: %s\nwant: %s", got, want)
				}
			})
		}
	}
}

func TestMotaiGeminiResponsesLeavesGPTUntouched(t *testing.T) {
	input := []byte(`{ "model":"gpt-test", "tools":[{"type":"namespace","name":"n","tools":[]}] }`)
	got, state, err := prepareGeminiResponses(input)
	if err != nil || state != nil || !bytes.Equal(got, input) {
		t.Fatalf("GPT request changed: %s %v", got, err)
	}
}

func TestMotaiGeminiResponsesNamespaceAndHistory(t *testing.T) {
	input := []byte(`{"model":"gemini-test","max_output_tokens":9007199254740993,"tools":[{"type":"namespace","name":"probe","tools":[{"type":"function","name":"marker","parameters":{"type":"object","properties":{"tag":{"type":"string"}}}}]},{"type":"web_search"}],"input":[{"type":"function_call","namespace":"probe","name":"marker","call_id":"c1","arguments":"{\"tag\":\"ok\"}"},{"type":"function_call_output","call_id":"c1","output":"done"},{"type":"tool_search_call","arguments":{"query":"marker"}},{"type":"tool_search_output","tools":[{"type":"namespace","name":"probe","tools":[{"type":"function","name":"marker"}]}]}],"tool_choice":{"type":"function","namespace":"probe","name":"marker"}}`)
	data, state, err := prepareGeminiResponses(input)
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := geminiDecode(data, &body); err != nil {
		t.Fatal(err)
	}
	tools := geminiArray(body["tools"])
	if len(tools) != 1 {
		t.Fatalf("native web search not removed: %s", data)
	}
	alias := geminiText(geminiObject(tools[0])["name"])
	if !strings.HasPrefix(alias, "gmn_probe_marker_") {
		t.Fatalf("invalid alias: %s", alias)
	}
	items := geminiArray(body["input"])
	if geminiObject(items[0])["name"] != alias || geminiObject(body["tool_choice"])["name"] != alias || geminiObject(items[1])["call_id"] != "c1" {
		t.Fatalf("history/choice broken: %s", data)
	}
	if _, ok := geminiObject(items[2])["arguments"].(string); !ok {
		t.Fatal("tool search arguments not stringified")
	}
	if geminiObject(geminiArray(geminiObject(items[3])["tools"])[0])["name"] != alias {
		t.Fatal("discovered tool alias differs")
	}
	if body["max_output_tokens"] != json.Number("9007199254740993") {
		t.Fatal("numeric field lost precision")
	}
	var restored bytes.Buffer
	response := fmt.Sprintf(`{"output":[{"type":"function_call","name":%q,"call_id":"c2","arguments":"{\"tag\":\"ok\"}"}],"usage":{"input_tokens":7}}`, alias)
	if err := state.rewrite(strings.NewReader(response), &restored, false); err != nil {
		t.Fatal(err)
	}
	var result map[string]any
	if err := geminiDecode(restored.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	call := geminiObject(geminiArray(result["output"])[0])
	if call["name"] != "marker" || call["namespace"] != "probe" || call["call_id"] != "c2" || geminiObject(result["usage"])["input_tokens"] != json.Number("7") {
		t.Fatalf("response identity/usage changed: %s", restored.Bytes())
	}
}

func TestMotaiGeminiResponsesCustomStreamAndHistory(t *testing.T) {
	data, state, err := prepareGeminiResponses([]byte(`{"model":"gemini-test","tools":[{"type":"custom","name":"apply_patch","format":{"type":"grammar","syntax":"lark","definition":"start: PATCH"}}],"input":[{"type":"custom_tool_call","name":"apply_patch","call_id":"c1","input":"old"},{"type":"custom_tool_call_output","call_id":"c1","output":"ok"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := geminiDecode(data, &body); err != nil {
		t.Fatal(err)
	}
	alias := geminiText(geminiObject(geminiArray(body["tools"])[0])["name"])
	if !strings.Contains(geminiText(geminiObject(geminiArray(body["tools"])[0])["description"]), "start: PATCH") {
		t.Fatal("custom grammar lost")
	}
	items := geminiArray(body["input"])
	if geminiObject(items[0])["type"] != "function_call" || geminiObject(items[1])["type"] != "function_call_output" || geminiObject(items[0])["call_id"] != "c1" {
		t.Fatalf("custom history broken: %s", data)
	}
	arguments := `{"input":"*** patch 中文\n"}`
	events := []map[string]any{
		{"type": "response.output_item.added", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "item1", "call_id": "c2", "name": alias, "arguments": ""}},
		{"type": "response.function_call_arguments.delta", "item_id": "item1", "delta": arguments},
		{"type": "response.function_call_arguments.done", "item_id": "item1", "arguments": arguments},
		{"type": "response.output_item.done", "output_index": 0, "item": map[string]any{"type": "function_call", "id": "item1", "call_id": "c2", "name": alias, "arguments": arguments}},
		{"type": "response.completed", "response": map[string]any{"output": []any{map[string]any{"type": "function_call", "id": "item1", "call_id": "c2", "name": alias, "arguments": arguments}}, "usage": map[string]any{"input_tokens": 9}}},
	}
	var input strings.Builder
	input.WriteString(": heartbeat\r\n\r\n")
	for i, event := range events {
		event["sequence_number"] = i
		raw, _ := json.Marshal(event)
		fmt.Fprintf(&input, "event: %s\r\ndata: %s\r\n\r\n", event["type"], raw)
	}
	input.WriteString("data: [DONE]\n\n")
	var output bytes.Buffer
	if err := state.rewrite(strings.NewReader(input.String()), &output, true); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if strings.Contains(text, "response.function_call_arguments") || strings.Count(text, `"type":"response.custom_tool_call_input.done"`) != 1 || !strings.Contains(text, `"type":"custom_tool_call"`) || !strings.Contains(text, `"name":"apply_patch"`) || !strings.Contains(text, "heartbeat") || !strings.Contains(text, "[DONE]") {
		t.Fatalf("bad custom stream: %s", text)
	}
	if !strings.Contains(text, `"call_id":"c2"`) || !strings.Contains(text, `"input_tokens":9`) {
		t.Fatal("stream identity or usage lost")
	}
}

func TestMotaiGeminiResponsesCustomDoneFallback(t *testing.T) {
	_, state, err := prepareGeminiResponses([]byte(`{"model":"gemini-test","tools":[{"type":"custom","name":"patch"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var alias string
	for name := range state.routes {
		alias = name
	}
	item := map[string]any{"type": "function_call", "name": alias, "id": "item-fallback", "call_id": "call-fallback", "arguments": "{\"input\":\"patch\"}"}
	events, err := state.events(map[string]any{"type": "response.output_item.done", "output_index": json.Number("0"), "item": item})
	if err != nil || len(events) != 3 {
		t.Fatalf("fallback failed: %v %v", events, err)
	}
	if events[0]["item_id"] != "item-fallback" || events[1]["input"] != "patch" || geminiObject(events[2]["item"])["call_id"] != "call-fallback" {
		t.Fatalf("fallback identity lost: %v", events)
	}
}

func TestMotaiGeminiResponsesRejectsInvalidCustomResult(t *testing.T) {
	data, state, err := prepareGeminiResponses([]byte(`{"model":"gemini-test","tools":[{"type":"custom","name":"patch"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := geminiDecode(data, &body); err != nil {
		t.Fatal(err)
	}
	alias := geminiText(geminiObject(geminiArray(body["tools"])[0])["name"])
	response := fmt.Sprintf(`{"output":[{"type":"function_call","name":%q,"arguments":"{\"input\":17}"}]}`, alias)
	var output bytes.Buffer
	if err := state.rewrite(strings.NewReader(response), &output, false); err == nil {
		t.Fatal("invalid custom input accepted")
	}
}
