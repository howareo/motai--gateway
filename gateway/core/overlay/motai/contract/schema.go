// Package contract validates the shared wire schemas without importing gateway business code.
package contract

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

const prefix = "https://motai.local/contracts/v1/"

var schemaFiles = []string{"common", "config", "usage", "records", "internal-api"}
var readable = map[string]bool{
	"usage": true, "intent": true, "terminal": true, "attempt": true, "event": true,
	"status": true, "activate_response": true, "events_page": true, "attempts_page": true,
	"stats_response": true, "models_response": true, "probe_response": true,
	"affinity_reset_response": true, "drain_response": true, "billing_probe_response": true,
	"wallet_probe_response": true, "error_response": true,
	"channel_health_response": true, "health_reset_response": true,
}

type Validator struct {
	write map[string]*jsonschema.Schema
	read  map[string]*jsonschema.Schema
}

type validationFailure struct {
	name    string
	keyword string
}

func (e *validationFailure) Error() string { return "invalid_contract: " + e.name }

// ValidationReason never returns instance values or library error messages.
func ValidationReason(err error) string {
	if err == nil {
		return "none"
	}
	var failure *validationFailure
	if errors.As(err, &failure) {
		return "schema:" + failure.keyword
	}
	switch reason := err.Error(); reason {
	case "count_availability_mismatch", "input_breakdown_mismatch", "cache_contradiction_unmarked",
		"reasoning_exceeds_output", "provider_count_mismatch", "attempt_identity_mismatch",
		"terminal_before_intent", "ttft_exceeds_duration", "success_semantics_mismatch", "not_sent_semantics_mismatch":
		return reason
	}
	return "invalid_contract"
}

func NewValidator(schemaDir string) (*Validator, error) {
	v := &Validator{write: map[string]*jsonschema.Schema{}, read: map[string]*jsonschema.Schema{}}
	for _, read := range []bool{false, true} {
		compiler := jsonschema.NewCompiler()
		compiler.Draft = jsonschema.Draft7
		compiler.LoadURL = func(string) (io.ReadCloser, error) { return nil, errors.New("external schema loading disabled") }
		compiler.Formats["motai-utc"] = stringFormat(isUTC)
		compiler.Formats["motai-http-url"] = stringFormat(isHTTPURL)
		compiler.Formats["motai-ip-cidr"] = stringFormat(isIPCIDR)
		names := map[string]string{}
		for _, file := range schemaFiles {
			data, err := os.ReadFile(filepath.Join(schemaDir, file+".schema.json"))
			if err != nil {
				return nil, fmt.Errorf("read contract schema: %w", err)
			}
			var schema map[string]interface{}
			if err := json.Unmarshal(data, &schema); err != nil {
				return nil, fmt.Errorf("parse contract schema: %w", err)
			}
			definitions := schema["definitions"].(map[string]interface{})
			if file != "common" {
				for name := range definitions {
					names[name] = file
				}
			}
			if read && file != "common" && file != "config" {
				var providerCounts interface{}
				if file == "usage" {
					providerCounts = definitions["provider_counts"]
				}
				allowReadAdditions(schema)
				if file == "usage" {
					// The persistence whitelist cannot expand through API read compatibility.
					providerCounts.(map[string]interface{})["additionalProperties"] = false
				}
				data, err = json.Marshal(schema)
				if err != nil {
					return nil, err
				}
			}
			if err := compiler.AddResource(prefix+file+".schema.json", bytes.NewReader(data)); err != nil {
				return nil, err
			}
		}
		for name, file := range names {
			if read && !readable[name] {
				continue
			}
			compiled, err := compiler.Compile(prefix + file + ".schema.json#/definitions/" + name)
			if err != nil {
				return nil, fmt.Errorf("compile %s: %w", name, err)
			}
			if read {
				v.read[name] = compiled
			} else {
				v.write[name] = compiled
			}
		}
	}
	for _, schemas := range []map[string]*jsonschema.Schema{v.write, v.read} {
		resolved := map[*jsonschema.Schema]*jsonschema.Schema{}
		for name, schema := range schemas {
			schemas[name] = collapseDraft7Refs(schema, resolved)
		}
	}
	return v, nil
}

// Draft 7 ignores $ref siblings. Reuse its compiled target to avoid allocating
// a second validation scope and unevaluated-property set for every reference.
func collapseDraft7Refs(schema *jsonschema.Schema, resolved map[*jsonschema.Schema]*jsonschema.Schema) *jsonschema.Schema {
	if schema == nil {
		return nil
	}
	if target, ok := resolved[schema]; ok {
		return target
	}
	resolved[schema] = schema
	if schema.Draft == jsonschema.Draft7 && schema.Ref != nil {
		target := collapseDraft7Refs(schema.Ref, resolved)
		resolved[schema] = target
		return target
	}
	for name, child := range schema.Properties {
		schema.Properties[name] = collapseDraft7Refs(child, resolved)
	}
	if child, ok := schema.Items.(*jsonschema.Schema); ok {
		schema.Items = collapseDraft7Refs(child, resolved)
	}
	for _, children := range [][]*jsonschema.Schema{schema.AllOf, schema.AnyOf, schema.OneOf} {
		for i, child := range children {
			children[i] = collapseDraft7Refs(child, resolved)
		}
	}
	if child, ok := schema.AdditionalProperties.(*jsonschema.Schema); ok {
		schema.AdditionalProperties = collapseDraft7Refs(child, resolved)
	}
	return schema
}

func stringFormat(validate func(string) bool) func(interface{}) bool {
	return func(value interface{}) bool { text, ok := value.(string); return !ok || validate(text) }
}

func allowReadAdditions(node interface{}) {
	switch value := node.(type) {
	case map[string]interface{}:
		for key, child := range value {
			if key == "additionalProperties" && child == false {
				value[key] = true
			} else {
				allowReadAdditions(child)
			}
		}
	case []interface{}:
		for _, child := range value {
			allowReadAdditions(child)
		}
	}
}

func decode(data []byte) (interface{}, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value interface{}
	if err := decoder.Decode(&value); err != nil {
		return nil, errors.New("invalid contract JSON")
	}
	var trailing interface{}
	if decoder.Decode(&trailing) != io.EOF {
		return nil, errors.New("invalid trailing contract JSON")
	}
	return value, nil
}

// DecodeValue decodes stored contract JSON while preserving numeric values.
func DecodeValue(data []byte) (interface{}, error) { return decode(data) }

func (v *Validator) validate(name string, data []byte, read bool) (interface{}, error) {
	schemas := v.write
	if read {
		schemas = v.read
	}
	schema, ok := schemas[name]
	if !ok {
		return nil, errors.New("unknown contract or mode")
	}
	value, err := decode(data)
	if err != nil {
		return nil, err
	}
	// Library errors may quote instance data; only a local stable classification escapes.
	if err := schema.Validate(value); err != nil {
		keyword := "unknown"
		var failure *jsonschema.ValidationError
		if errors.As(err, &failure) {
			for len(failure.Causes) > 0 {
				failure = failure.Causes[0]
			}
			// KeywordLocation is a path in our schema, not the submitted instance.
			if path := failure.KeywordLocation; len(path) <= 180 && regexp.MustCompile(`^[A-Za-z0-9_/#~-]*$`).MatchString(path) {
				keyword = path
			}
		}
		return nil, &validationFailure{name: name, keyword: keyword}
	}
	return value, nil
}

func (v *Validator) Validate(name string, data []byte) error {
	_, err := v.validate(name, data, false)
	return err
}

func (v *Validator) ValidateRead(name string, data []byte) error {
	_, err := v.validate(name, data, true)
	return err
}

// ValidatePageValue validates a page that has already been decoded by the
// caller. Internal page producers use this to avoid decoding the same JSON a
// second time after serialization; it applies the same read schema and
// cross-record relations as ValidatePage.
func (v *Validator) ValidatePageValue(name string, value interface{}) error {
	if name != "attempts_page" && name != "events_page" {
		return errors.New("invalid page contract")
	}
	schema, ok := v.read[name]
	if !ok || schema.Validate(value) != nil {
		return fmt.Errorf("invalid_contract: %s", name)
	}
	key, record := "attempts", "attempt"
	if name == "events_page" {
		key, record = "events", "event"
	}
	page := object(value)
	for _, item := range rows(page[key]) {
		if err := recordRelations(record, object(item), true); err != nil {
			return err
		}
	}
	return nil
}

var utcPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`)
var forbiddenURL = regexp.MustCompile(`[\s\x00-\x1f\x7f\\]`)
var cidrMask = regexp.MustCompile(`^(0|[1-9][0-9]*)$`)

func isUTC(value string) bool {
	if !utcPattern.MatchString(value) || strings.HasPrefix(value, "0000-") {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, value)
	return err == nil
}

func isHTTPURL(value string) bool {
	if forbiddenURL.MatchString(value) {
		return false
	}
	u, err := url.Parse(value)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && u.Fragment == "" && u.RawQuery == "" && !u.ForceQuery
}

func isIPCIDR(value string) bool {
	if !strings.Contains(value, "/") {
		return net.ParseIP(value) != nil
	}
	parts := strings.Split(value, "/")
	if len(parts) != 2 || !cidrMask.MatchString(parts[1]) {
		return false
	}
	_, _, err := net.ParseCIDR(value)
	return err == nil
}
