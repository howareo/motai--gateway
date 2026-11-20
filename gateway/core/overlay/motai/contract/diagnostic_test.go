package contract

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestValidationDiagnostics(t *testing.T) {
	if got := ValidationReason(errors.New("reasoning_exceeds_output")); got != "reasoning_exceeds_output" {
		t.Fatal(got)
	}
	const secret = "PRIVATE-INSTANCE-VALUE"
	if got := ValidationReason(errors.New(secret)); got != "invalid_contract" {
		t.Fatal("unclassified errors must be redacted")
	}
	v, root := validator(t)
	var vectors struct {
		Vectors []struct {
			Expected map[string]interface{} `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(fixture(t, root, "usage-vectors.json"), &vectors); err != nil {
		t.Fatal(err)
	}
	if len(vectors.Vectors) == 0 {
		t.Fatal("missing usage vectors")
	}
	value := vectors.Vectors[0].Expected
	value["provider"] = secret
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	err = v.ValidateUsage(data, false)
	if err == nil {
		t.Fatal("invalid provider accepted")
	}
	reason := ValidationReason(err)
	if !strings.HasPrefix(reason, "schema:") || reason == "schema:unknown" || strings.Contains(reason, secret) || strings.Contains(err.Error(), secret) {
		t.Fatalf("unsafe or missing validation diagnostic: %q", reason)
	}
}
