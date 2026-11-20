package jsonbody

import (
	"strings"
	"testing"
)

func TestValidateAmbiguousClientJSON(t *testing.T) {
	for _, body := range []string{
		`{"model":"a","model":"b"}`,
		`{"model":"a","Model":"a"}`,
		`{"model":"a","\u006dodel":"b"}`,
		`{"prompt_cache_key":"a","prompt_cache_Key":"b"}`,
		`{"reasoning":{"effort":"low","Effort":"high"}}`,
		`{"messages":[{"role":"user","role":"system"}]}`,
		`{"tools":[{"input_schema":{"properties":{"x":{},"x":{}}}}]}`,
		`{"model":"a"} {"model":"b"}`,
		`{"model":`, `[]`,
	} {
		if err := Validate(strings.NewReader(body)); err == nil {
			t.Errorf("accepted ambiguous or invalid fixture: %s", body)
		} else if strings.Contains(err.Error(), body) {
			t.Fatal("validation leaked request data")
		}
	}
	for _, body := range []string{
		`{"model":"a","messages":[{"role":"user","content":"model model"}]}`,
		`{"tools":[{"input_schema":{"properties":{"id":{},"ID":{}}}}]}`,
		`{"input":[{"type":"function_call","arguments":{"id":1,"ID":2}}]}`,
		`{"contents":[{"parts":[{"functionCall":{"args":{"id":1,"ID":2}}}]}]}`,
	} {
		if err := Validate(strings.NewReader(body)); err != nil {
			t.Errorf("rejected valid tool/schema fixture: %v", err)
		}
	}
}
