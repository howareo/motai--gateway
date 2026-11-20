package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func contractRoot(t *testing.T) string {
	t.Helper()
	if root := os.Getenv("MOTAI_CONTRACTS_DIR"); root != "" {
		return root
	}
	_, file, _, _ := runtime.Caller(0)
	for current := filepath.Dir(file); ; current = filepath.Dir(current) {
		if _, err := os.Stat(filepath.Join(current, "contracts", "v1", "common.schema.json")); err == nil {
			return filepath.Join(current, "contracts")
		}
		if parent := filepath.Dir(current); parent == current {
			break
		}
	}
	t.Fatal("set MOTAI_CONTRACTS_DIR to the shared contracts directory")
	return ""
}

func fixture(t *testing.T, root, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(root, "fixtures", name))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func validator(t *testing.T) (*Validator, string) {
	t.Helper()
	root := contractRoot(t)
	v, err := NewValidator(filepath.Join(root, "v1"))
	if err != nil {
		t.Fatal(err)
	}
	return v, root
}

func TestSharedContractVectors(t *testing.T) {
	v, root := validator(t)
	var fixtures struct {
		Vectors []struct {
			ID       string          `json:"id"`
			Contract string          `json:"contract"`
			Mode     string          `json:"mode"`
			Valid    bool            `json:"valid"`
			Domain   string          `json:"domain"`
			Value    json.RawMessage `json:"value"`
			Options  struct {
				Credentials      json.RawMessage `json:"credentials"`
				ForbiddenTargets []string        `json:"forbiddenTargets"`
			} `json:"options"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(fixture(t, root, "contract-vectors.json"), &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, vector := range fixtures.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			var err error
			switch vector.Domain {
			case "config":
				err = v.ValidateConfig(vector.Value, vector.Options.Credentials, vector.Options.ForbiddenTargets)
			case "usage":
				err = v.ValidateUsage(vector.Value, vector.Mode == "read")
			case "record":
				err = v.ValidateRecord(vector.Contract, vector.Value, vector.Mode == "read")
			default:
				if vector.Mode == "read" {
					err = v.ValidateRead(vector.Contract, vector.Value)
				} else {
					err = v.Validate(vector.Contract, vector.Value)
				}
			}
			if (err == nil) != vector.Valid {
				t.Fatalf("valid=%v expected=%v error=%v", err == nil, vector.Valid, err)
			}
		})
	}
}

func TestSharedChannelAdapterVectors(t *testing.T) {
	v, root := validator(t)
	var vectors struct {
		Vectors []struct {
			ID      string          `json:"id"`
			Adapter json.RawMessage `json:"adapter"`
			Valid   bool            `json:"valid"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(fixture(t, root, "channel-adapter-vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			var config map[string]any
			if err := json.Unmarshal(fixture(t, root, "config-valid.json"), &config); err != nil {
				t.Fatal(err)
			}
			if vector.Adapter != nil {
				var value any
				if err := json.Unmarshal(vector.Adapter, &value); err != nil {
					t.Fatal(err)
				}
				config["channels"].([]any)[0].(map[string]any)["adapter"] = value
			}
			data, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			err = v.ValidateConfig(data, nil, nil)
			if (err == nil) != vector.Valid {
				t.Fatalf("valid=%v expected=%v error=%v", err == nil, vector.Valid, err)
			}
		})
	}
}

func TestSharedCallerTokenAliasVectors(t *testing.T) {
	v, root := validator(t)
	var vectors struct {
		Vectors []struct {
			ID      string           `json:"id"`
			Valid   bool             `json:"valid"`
			Callers []map[string]any `json:"callers"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(fixture(t, root, "caller-token-alias-vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			var config map[string]any
			if err := json.Unmarshal(fixture(t, root, "config-valid.json"), &config); err != nil {
				t.Fatal(err)
			}
			template := config["callers"].([]any)[0].(map[string]any)
			callers := make([]any, 0, len(vector.Callers))
			for index, identity := range vector.Callers {
				caller := make(map[string]any, len(template)+1)
				for key, value := range template {
					caller[key] = value
				}
				caller["id"] = strings.Repeat("c", index+1)
				for key, value := range identity {
					caller[key] = value
				}
				callers = append(callers, caller)
			}
			config["callers"] = callers
			data, err := json.Marshal(config)
			if err != nil {
				t.Fatal(err)
			}
			err = v.ValidateConfig(data, nil, nil)
			if (err == nil) != vector.Valid {
				t.Fatalf("valid=%v expected=%v error=%v", err == nil, vector.Valid, err)
			}
		})
	}
}

func TestSharedUsageExpectations(t *testing.T) {
	v, root := validator(t)
	var fixtures struct {
		Vectors []struct {
			ID       string          `json:"id"`
			Expected json.RawMessage `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(fixture(t, root, "usage-vectors.json"), &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, vector := range fixtures.Vectors {
		t.Run(vector.ID, func(t *testing.T) {
			if err := v.ValidateUsage(vector.Expected, false); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestReadCannotRelaxMutationsOrExposeValues(t *testing.T) {
	v, root := validator(t)
	if v.ValidateRead("config", fixture(t, root, "config-valid.json")) == nil {
		t.Fatal("configuration read relaxation accepted")
	}
	if v.ValidateRead("activate_request", []byte(`{}`)) == nil {
		t.Fatal("write read relaxation accepted")
	}
	err := v.Validate("activate_request", []byte(`{"CANARY_SECRET_BODY":true}`))
	if err == nil || strings.Contains(err.Error(), "CANARY_SECRET_BODY") {
		t.Fatal("unsafe contract validation error")
	}
	if v.Validate("status", []byte(`{} {}`)) == nil {
		t.Fatal("trailing JSON accepted")
	}
}

func TestPageValidationUsesReadSchema(t *testing.T) {
	v, root := validator(t)
	var samples struct {
		Samples map[string]json.RawMessage `json:"samples"`
	}
	if err := json.Unmarshal(fixture(t, root, "internal-api-samples.json"), &samples); err != nil {
		t.Fatal(err)
	}
	value, err := DecodeValue(samples.Samples["events_page"])
	if err != nil {
		t.Fatal(err)
	}
	page := object(value)
	page["future_optional"] = true
	rows(page["events"])[0].(map[string]interface{})["future_event_optional"] = true
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := v.ValidatePage("events_page", data); err != nil {
		t.Fatalf("page response rejected by write schema: %v", err)
	}
	if err := v.ValidatePageValue("events_page", value); err != nil {
		t.Fatalf("decoded page response rejected: %v", err)
	}
}

func TestQueryAndNanosecondRecordRelations(t *testing.T) {
	v, root := validator(t)
	var samples struct {
		Samples map[string]json.RawMessage `json:"samples"`
	}
	if err := json.Unmarshal(fixture(t, root, "internal-api-samples.json"), &samples); err != nil {
		t.Fatal(err)
	}
	if err := v.ValidateQuery("attempts_query", samples.Samples["attempts_query"]); err != nil {
		t.Fatal(err)
	}
	var query map[string]interface{}
	if err := json.Unmarshal(samples.Samples["attempts_query"], &query); err != nil {
		t.Fatal(err)
	}
	query["to"] = query["from"]
	data, _ := json.Marshal(query)
	if v.ValidateQuery("attempts_query", data) == nil {
		t.Fatal("empty interval accepted")
	}
	var attempt map[string]interface{}
	if err := json.Unmarshal(fixture(t, root, "attempt-valid.json"), &attempt); err != nil {
		t.Fatal(err)
	}
	object(attempt["intent"])["started_at"] = "2026-10-25T16:00:00.000000002Z"
	object(attempt["terminal"])["ended_at"] = "2026-10-25T16:00:00.000000001Z"
	data, _ = json.Marshal(attempt)
	if v.ValidateRecord("attempt", data, false) == nil {
		t.Fatal("nanosecond inversion accepted")
	}
}

func TestSharedNullableHotPathBoundaries(t *testing.T) {
	v, root := validator(t)
	for _, tc := range []struct {
		name    string
		field   string
		valid   []interface{}
		invalid []interface{}
	}{
		{"usage", "value", []interface{}{nil, 0, 9007199254740991}, []interface{}{"1", -1, 0.5, 9007199254740992}},
		{"terminal", "upstream_status", []interface{}{nil, 100, 599}, []interface{}{"200", 99, 600, 200.5}},
		{"intent", "value", []interface{}{nil, "medium"}, []interface{}{"", "bad space", true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var attempt map[string]interface{}
			if err := json.Unmarshal(fixture(t, root, "attempt-valid.json"), &attempt); err != nil {
				t.Fatal(err)
			}
			var value, target map[string]interface{}
			switch tc.name {
			case "usage":
				value = object(object(attempt["terminal"])["usage"])
				target = object(value["total_input"])
			case "terminal":
				value = object(attempt["terminal"])
				target = value
			default:
				value = object(attempt["intent"])
				target = object(value["effort"])
			}
			for _, item := range tc.valid {
				target[tc.field] = item
				data, _ := json.Marshal(value)
				if err := v.Validate(tc.name, data); err != nil {
					t.Fatalf("valid value rejected: %v", err)
				}
			}
			for _, item := range tc.invalid {
				target[tc.field] = item
				data, _ := json.Marshal(value)
				if v.Validate(tc.name, data) == nil {
					t.Fatal("invalid value accepted")
				}
			}
			delete(target, tc.field)
			data, _ := json.Marshal(value)
			if v.Validate(tc.name, data) == nil {
				t.Fatal("required nullable value absent")
			}
		})
	}
}

func TestWildcardPermissionDomainErrorsAreStable(t *testing.T) {
	v, root := validator(t)
	var fixtures struct {
		Vectors []struct {
			ID    string          `json:"id"`
			Value json.RawMessage `json:"value"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(fixture(t, root, "contract-vectors.json"), &fixtures); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"config_permission_wildcard_sole":                 "",
		"config_permission_wildcard_mixed_with_model":     "permission_wildcard_mixed",
		"config_permission_wildcard_mixed_with_unknown":   "permission_wildcard_mixed",
		"config_permission_wildcard_channel_outside_pool": "permission_channel_outside_pool",
		// channel_ids and protocols take the same sole "*" as model_ids; "*" as channel_ids skips the pool membership check.
		"config_permission_wildcard_channels_sole":                     "",
		"config_permission_wildcard_protocols_sole":                    "",
		"config_permission_wildcard_all_three":                         "",
		"config_permission_wildcard_all_three_other_pool":              "",
		"config_permission_wildcard_channels_mixed_with_id":            "permission_wildcard_mixed",
		"config_permission_wildcard_channels_mixed_with_unknown":       "permission_wildcard_mixed",
		"config_permission_wildcard_protocols_mixed_with_protocol":     "permission_wildcard_mixed",
		"config_permission_wildcard_protocols_mixed_with_count_tokens": "permission_wildcard_mixed",
		"config_permission_channels_unknown_id_without_wildcard":       "permission_channel_outside_pool",
	}
	// These fail the JSON Schema itself (not a domain rule): the wildcard is the literal "*" only.
	schemaRejected := map[string]bool{
		"config_permission_protocols_unknown_value":      true,
		"config_permission_protocols_wildcard_lookalike": true,
		"config_permission_channels_wildcard_lookalike":  true,
	}
	rejected := 0
	for _, vector := range fixtures.Vectors {
		if schemaRejected[vector.ID] {
			rejected++
			if err := v.ValidateConfig(vector.Value, nil, nil); err == nil {
				t.Fatalf("%s: expected a schema rejection", vector.ID)
			}
		}
	}
	if rejected != len(schemaRejected) {
		t.Fatalf("expected %d schema-rejected vectors, found %d", len(schemaRejected), rejected)
	}
	seen := 0
	for _, vector := range fixtures.Vectors {
		code, ok := want[vector.ID]
		if !ok {
			continue
		}
		seen++
		err := v.ValidateConfig(vector.Value, nil, nil)
		switch {
		case code == "" && err != nil:
			t.Fatalf("%s: unexpected error %v", vector.ID, err)
		case code != "" && (err == nil || err.Error() != code):
			t.Fatalf("%s: got %v want %s", vector.ID, err, code)
		}
	}
	if seen != len(want) {
		t.Fatalf("expected %d wildcard vectors, found %d", len(want), seen)
	}
}
