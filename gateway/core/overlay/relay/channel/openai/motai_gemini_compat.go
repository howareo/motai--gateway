package openai

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

const geminiDefaultCodexIdentity = "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals."
const geminiShortCodexIdentity = "You are Codex, a coding agent."

type geminiToolRoute struct{ kind, name, namespace string }
type geminiToolCall struct {
	arguments string
	done      bool
}
type geminiResponsesCompat struct {
	routes     map[string]geminiToolRoute
	identities map[string]string
	reserved   map[string]bool
	calls      map[string]*geminiToolCall
	sequence   int
}

func geminiObject(value any) map[string]any { result, _ := value.(map[string]any); return result }
func geminiArray(value any) []any           { result, _ := value.([]any); return result }
func geminiText(value any) string           { result, _ := value.(string); return result }
func geminiDecode(data []byte, value any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(value)
}

func prepareGeminiResponses(data []byte) ([]byte, *geminiResponsesCompat, error) {
	var body map[string]any
	if err := geminiDecode(data, &body); err != nil {
		return nil, nil, err
	}
	if !strings.HasPrefix(geminiText(body["model"]), "gemini-") {
		return data, nil, nil
	}
	if body["instructions"] == geminiDefaultCodexIdentity {
		body["instructions"] = geminiShortCodexIdentity
	}
	for _, value := range geminiArray(body["input"]) {
		item := geminiObject(value)
		if item["role"] != "system" && item["role"] != "developer" {
			continue
		}
		if item["content"] == geminiDefaultCodexIdentity {
			item["content"] = geminiShortCodexIdentity
		}
		for _, value := range geminiArray(item["content"]) {
			part := geminiObject(value)
			if part["type"] == "input_text" && part["text"] == geminiDefaultCodexIdentity {
				part["text"] = geminiShortCodexIdentity
			}
		}
	}
	state := &geminiResponsesCompat{routes: map[string]geminiToolRoute{}, identities: map[string]string{}, reserved: map[string]bool{}, calls: map[string]*geminiToolCall{}}
	var reserve func([]any)
	reserve = func(tools []any) {
		for _, value := range tools {
			tool := geminiObject(value)
			if tool["type"] == "namespace" {
				reserve(geminiArray(tool["tools"]))
			} else if name := geminiText(tool["name"]); name != "" {
				state.reserved[name] = true
			}
		}
	}
	reserve(geminiArray(body["tools"]))
	for _, value := range geminiArray(body["input"]) {
		item := geminiObject(value)
		if name := geminiText(item["name"]); name != "" {
			state.reserved[name] = true
		}
		if item["type"] == "tool_search_output" {
			reserve(geminiArray(item["tools"]))
		}
	}
	if tools, ok := body["tools"].([]any); ok {
		tools = state.flatten(tools, "", "")
		hasFunction := false
		for _, value := range tools {
			if geminiObject(value)["type"] == "function" {
				hasFunction = true
			}
		}
		if hasFunction {
			filtered := make([]any, 0, len(tools))
			for _, value := range tools {
				kind := geminiObject(value)["type"]
				if kind != "web_search" && kind != "web_search_preview" {
					filtered = append(filtered, value)
				}
			}
			tools = filtered
		}
		body["tools"] = tools
	}
	for _, value := range geminiArray(body["input"]) {
		item := geminiObject(value)
		switch item["type"] {
		case "tool_search_call":
			if arguments, ok := item["arguments"].(map[string]any); ok {
				encoded, err := json.Marshal(arguments)
				if err != nil {
					return nil, nil, err
				}
				item["arguments"] = string(encoded)
			}
		case "tool_search_output":
			if tools, ok := item["tools"].([]any); ok {
				item["tools"] = state.flatten(tools, "", "")
			}
		case "custom_tool_call_output":
			item["type"] = "function_call_output"
		case "custom_tool_call", "function_call":
			kind := "function"
			if item["type"] == "custom_tool_call" {
				kind = "custom"
			}
			item["name"] = state.alias(kind, geminiText(item["name"]), geminiText(item["namespace"]))
			item["type"] = "function_call"
			delete(item, "namespace")
			if kind == "custom" {
				encoded, err := json.Marshal(map[string]any{"input": item["input"]})
				if err != nil {
					return nil, nil, err
				}
				item["arguments"] = string(encoded)
				delete(item, "input")
			}
		}
	}
	state.choice(geminiObject(body["tool_choice"]))
	result, err := json.Marshal(body)
	return result, state, err
}

func (state *geminiResponsesCompat) alias(kind, name, namespace string) string {
	if kind == "function" && namespace == "" {
		return name
	}
	identity, _ := json.Marshal([]string{kind, namespace, name})
	if alias, ok := state.identities[string(identity)]; ok {
		return alias
	}
	label := name
	if namespace != "" {
		label = namespace + "_" + name
	}
	var safe strings.Builder
	for _, ch := range label {
		if ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-' {
			safe.WriteRune(ch)
		} else {
			safe.WriteByte('_')
		}
		if safe.Len() >= 20 {
			break
		}
	}
	digest := sha256.Sum256(identity)
	base := "gmn_" + safe.String() + "_" + hex.EncodeToString(digest[:16])
	alias := base
	for i := 1; state.reserved[alias] || state.routes[alias].name != ""; i++ {
		alias = base + "_" + strconv.Itoa(i)
	}
	state.routes[alias] = geminiToolRoute{kind, name, namespace}
	state.identities[string(identity)] = alias
	return alias
}

func (state *geminiResponsesCompat) flatten(tools []any, namespace, description string) []any {
	result := make([]any, 0, len(tools))
	for _, value := range tools {
		tool := geminiObject(value)
		kind := geminiText(tool["type"])
		name := geminiText(tool["name"])
		if kind == "namespace" {
			nested := name
			if namespace != "" {
				nested = namespace + "." + name
			}
			result = append(result, state.flatten(geminiArray(tool["tools"]), nested, strings.TrimSpace(description+"\n"+geminiText(tool["description"])))...)
			continue
		}
		if kind != "function" && kind != "custom" {
			result = append(result, value)
			continue
		}
		alias := state.alias(kind, name, namespace)
		if kind == "custom" {
			detail := strings.TrimSpace(description + "\n" + namespace + "." + name + ": " + geminiText(tool["description"]) + " Pass the complete raw tool input in input.")
			format := geminiObject(tool["format"])
			if format["type"] == "grammar" {
				detail += "\nInput grammar (" + geminiText(format["syntax"]) + "):\n" + geminiText(format["definition"])
			}
			tool = map[string]any{"type": "function", "name": alias, "description": detail, "parameters": map[string]any{"type": "object", "properties": map[string]any{"input": map[string]any{"type": "string"}}, "required": []string{"input"}, "additionalProperties": false}, "strict": true}
		} else {
			tool["name"] = alias
			if namespace != "" {
				tool["description"] = strings.TrimSpace(description + "\n" + namespace + "." + name + ": " + geminiText(tool["description"]))
			}
		}
		result = append(result, tool)
	}
	return result
}

func (state *geminiResponsesCompat) choice(tool map[string]any) {
	if tool["type"] == "allowed_tools" {
		for _, value := range geminiArray(tool["tools"]) {
			state.choice(geminiObject(value))
		}
		return
	}
	kind := geminiText(tool["type"])
	if kind != "function" && kind != "custom" {
		return
	}
	tool["name"] = state.alias(kind, geminiText(tool["name"]), geminiText(tool["namespace"]))
	tool["type"] = "function"
	delete(tool, "namespace")
}

func geminiCustomInput(arguments any) (string, error) {
	var wrapper map[string]any
	if err := geminiDecode([]byte(geminiText(arguments)), &wrapper); err != nil {
		return "", fmt.Errorf("invalid Gemini custom tool arguments: %w", err)
	}
	input, ok := wrapper["input"].(string)
	if !ok {
		return "", fmt.Errorf("invalid Gemini custom tool input")
	}
	return input, nil
}

func (state *geminiResponsesCompat) restoreItem(item map[string]any, added bool) error {
	route, found := state.routes[geminiText(item["name"])]
	if !found || item["type"] != "function_call" {
		return nil
	}
	item["name"] = route.name
	delete(item, "namespace")
	if route.namespace != "" {
		item["namespace"] = route.namespace
	}
	if route.kind == "custom" {
		input := ""
		if !added {
			var err error
			input, err = geminiCustomInput(item["arguments"])
			if err != nil {
				return err
			}
		}
		item["type"], item["input"] = "custom_tool_call", input
		delete(item, "arguments")
	}
	return nil
}

func (state *geminiResponsesCompat) restoreResponse(response map[string]any) error {
	for _, value := range geminiArray(response["output"]) {
		if err := state.restoreItem(geminiObject(value), false); err != nil {
			return err
		}
	}
	return nil
}

func (state *geminiResponsesCompat) events(event map[string]any) ([]map[string]any, error) {
	item := geminiObject(event["item"])
	if item["type"] == "function_call" && state.routes[geminiText(item["name"])].kind == "custom" {
		id := geminiText(item["id"])
		call := state.calls[id]
		if call == nil {
			call = &geminiToolCall{}
		}
		if id != "" {
			state.calls[id] = call
		}
		if index, ok := event["output_index"]; ok {
			state.calls[fmt.Sprint(index)] = call
		}
	}
	key := geminiText(event["item_id"])
	if key == "" {
		key = fmt.Sprint(event["output_index"])
	}
	call := state.calls[key]
	kind := geminiText(event["type"])
	if call != nil && kind == "response.function_call_arguments.delta" {
		call.arguments += geminiText(event["delta"])
		return nil, nil
	}
	finish := func(arguments any) ([]map[string]any, error) {
		if call.done {
			return nil, nil
		}
		input, err := geminiCustomInput(arguments)
		if err != nil {
			return nil, err
		}
		call.done = true
		base := map[string]any{}
		for key, value := range event {
			if key != "type" && key != "arguments" && key != "delta" && key != "item" {
				base[key] = value
			}
		}
		if _, exists := base["item_id"]; !exists && item["id"] != nil {
			base["item_id"] = item["id"]
		}
		delta := map[string]any{}
		for key, value := range base {
			delta[key] = value
		}
		delta["type"], delta["delta"] = "response.custom_tool_call_input.delta", input
		base["type"], base["input"] = "response.custom_tool_call_input.done", input
		return []map[string]any{delta, base}, nil
	}
	if call != nil && kind == "response.function_call_arguments.done" {
		arguments, ok := event["arguments"]
		if !ok {
			arguments = call.arguments
		}
		return finish(arguments)
	}
	var prefix []map[string]any
	if kind == "response.output_item.done" && item != nil {
		call = state.calls[geminiText(item["id"])]
		if call == nil {
			call = state.calls[fmt.Sprint(event["output_index"])]
		}
		if call != nil && !call.done {
			var err error
			prefix, err = finish(item["arguments"])
			if err != nil {
				return nil, err
			}
		}
	}
	if err := state.restoreItem(item, kind == "response.output_item.added"); err != nil {
		return nil, err
	}
	if err := state.restoreResponse(geminiObject(event["response"])); err != nil {
		return nil, err
	}
	return append(prefix, event), nil
}

func (state *geminiResponsesCompat) rewrite(reader io.Reader, writer io.Writer, stream bool) error {
	if !stream {
		var response map[string]any
		decoder := json.NewDecoder(reader)
		decoder.UseNumber()
		if err := decoder.Decode(&response); err != nil {
			return err
		}
		if err := state.restoreResponse(response); err != nil {
			return err
		}
		return json.NewEncoder(writer).Encode(response)
	}
	input := bufio.NewReader(reader)
	var frame []string
	flush := func() error {
		var data []string
		var others []string
		hasEvent := false
		for _, line := range frame {
			if strings.HasPrefix(line, "data:") {
				data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			} else if strings.HasPrefix(line, "event:") {
				hasEvent = true
			} else {
				others = append(others, line)
			}
		}
		text := strings.Join(data, "\n")
		if text == "" || text == "[DONE]" {
			_, err := io.WriteString(writer, strings.Join(frame, "\n")+"\n\n")
			return err
		}
		var event map[string]any
		if err := geminiDecode([]byte(text), &event); err != nil {
			return err
		}
		converted, err := state.events(event)
		if err != nil {
			return err
		}
		for _, value := range converted {
			if _, ok := event["sequence_number"]; ok || len(converted) > 1 {
				value["sequence_number"] = state.sequence
				state.sequence++
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				return err
			}
			lines := append([]string{}, others...)
			if hasEvent {
				lines = append(lines, "event: "+geminiText(value["type"]))
			}
			lines = append(lines, "data: "+string(encoded))
			if _, err := io.WriteString(writer, strings.Join(lines, "\n")+"\n\n"); err != nil {
				return err
			}
		}
		return nil
	}
	for {
		line, err := input.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
			if line == "" {
				if err := flush(); err != nil {
					return err
				}
				frame = nil
			} else {
				frame = append(frame, line)
			}
		}
		if err != nil {
			if err != io.EOF {
				return err
			}
			if len(frame) > 0 {
				return flush()
			}
			return nil
		}
	}
}
