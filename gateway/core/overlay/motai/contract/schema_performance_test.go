package contract

import (
	"bytes"
	"encoding/json"
	"math/big"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v5"
)

func TestIntegerDomainExactForms(t *testing.T) {
	for _, raw := range []string{"0", "-0", "1", "-1", "9007199254740993", "9223372036854775808", "-9223372036854775809", "1.0", "1e0", "10e-1", "1e30", "-12.00e2"} {
		t.Run(raw, func(t *testing.T) {
			reference, ok := new(big.Rat).SetString(raw)
			if !ok || !reference.IsInt() {
				t.Fatal("invalid integer test input")
			}
			if got := integer(json.Number(raw)); got.Cmp(reference.Num()) != 0 {
				t.Fatalf("integer(%s) = %s; want %s", raw, got, reference.Num())
			}
		})
	}
	if integer(nil) != nil {
		t.Fatal("nil count must stay absent")
	}
	for _, raw := range []string{"1e-1", "-0.1", "1.5"} {
		t.Run("noninteger/"+raw, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("noninteger must retain the schema invariant panic")
				}
			}()
			integer(json.Number(raw))
		})
	}
}

func TestCollapsedPageSchemasMatchOriginal(t *testing.T) {
	v, root := validator(t)
	var samples struct {
		Samples map[string]interface{} `json:"samples"`
	}
	decoded, err := decode(fixture(t, root, "internal-api-samples.json"))
	if err != nil {
		t.Fatal(err)
	}
	samples.Samples = object(object(decoded)["samples"])
	compiler := jsonschema.NewCompiler()
	compiler.Draft = jsonschema.Draft7
	compiler.Formats["motai-utc"] = stringFormat(isUTC)
	compiler.Formats["motai-http-url"] = stringFormat(isHTTPURL)
	compiler.Formats["motai-ip-cidr"] = stringFormat(isIPCIDR)
	for _, file := range schemaFiles {
		data, err := os.ReadFile(filepath.Join(root, "v1", file+".schema.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := compiler.AddResource(prefix+file+".schema.json", bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"events_page", "attempts_page"} {
		t.Run(name, func(t *testing.T) {
			original, err := compiler.Compile(prefix + "internal-api.schema.json#/definitions/" + name)
			if err != nil {
				t.Fatal(err)
			}
			value := samples.Samples[name]
			checks := 0
			check := func() {
				t.Helper()
				checks++
				if (original.Validate(value) == nil) != (v.write[name].Validate(value) == nil) {
					t.Fatalf("schema mismatch at mutation %d", checks)
				}
			}
			check()
			var mutate func(interface{})
			mutate = func(node interface{}) {
				if fields, ok := node.(map[string]interface{}); ok {
					fields["CANARY_EXTRA_FIELD"] = true
					check()
					delete(fields, "CANARY_EXTRA_FIELD")
					for key, saved := range fields {
						delete(fields, key)
						check()
						for _, replacement := range []interface{}{nil, true, "", "bad space", "9007199254740993", json.Number("0"), json.Number("-1"), json.Number("0.5"), json.Number("9007199254740992"), json.Number("1e0"), []interface{}{}, map[string]interface{}{}} {
							fields[key] = replacement
							check()
						}
						fields[key] = saved
						mutate(saved)
					}
				}
				if items, ok := node.([]interface{}); ok {
					for _, item := range items {
						mutate(item)
					}
				}
			}
			mutate(value)
			t.Logf("original and collapsed schema agreed on %d mutations", checks)
		})
	}
}

func TestCollapseDraft7RefsPreservesCyclesAndDraft(t *testing.T) {
	for _, source := range []string{
		`{"type":"object","properties":{"child":{"$ref":"#"}}}`,
		`{"$ref":"#/definitions/value","type":"string","definitions":{"value":{"type":"integer","minimum":1}}}`,
		`{"$schema":"https://json-schema.org/draft/2020-12/schema","$ref":"#/definitions/value","maximum":2,"definitions":{"value":{"type":"integer","minimum":1}}}`,
	} {
		compiler := jsonschema.NewCompiler()
		compiler.Draft = jsonschema.Draft7
		if err := compiler.AddResource("https://motai.local/test", bytes.NewBufferString(source)); err != nil {
			t.Fatal(err)
		}
		schema, err := compiler.Compile("https://motai.local/test")
		if err != nil {
			t.Fatal(err)
		}
		values := []interface{}{nil, "x", json.Number("0"), json.Number("1"), json.Number("3"), map[string]interface{}{"child": map[string]interface{}{}}}
		valid := make([]bool, len(values))
		for i, value := range values {
			valid[i] = schema.Validate(value) == nil
		}
		schema = collapseDraft7Refs(schema, map[*jsonschema.Schema]*jsonschema.Schema{})
		for i, value := range values {
			if (schema.Validate(value) == nil) != valid[i] {
				t.Fatal("reference semantics changed")
			}
		}
	}
}

func BenchmarkEventsPage500(b *testing.B) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	v, err := NewValidator(filepath.Join(root, "v1"))
	if err != nil {
		b.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(root, "fixtures", "internal-api-samples.json"))
	if err != nil {
		b.Fatal(err)
	}
	var fixtures struct {
		Samples map[string]map[string]interface{} `json:"samples"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		b.Fatal(err)
	}
	page := fixtures.Samples["events_page"]
	event := page["events"].([]interface{})[0]
	events := make([]interface{}, 500)
	for i := range events {
		events[i] = event
	}
	page["events"] = events
	data, err = json.Marshal(page)
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if err := v.ValidatePage("events_page", data); err != nil {
			b.Fatal(err)
		}
	}
}

func TestNumericValidationExactBoundaries(t *testing.T) {
	cases := []struct {
		schema string
		value  string
		valid  bool
	}{
		{"{\"type\":\"integer\"}", "-9223372036854775808", true},
		{"{\"type\":\"integer\"}", "9223372036854775807", true},
		{"{\"type\":\"integer\"}", "-9223372036854775809", true},
		{"{\"type\":\"integer\"}", "9223372036854775808", true},
		{"{\"type\":\"integer\"}", "1.0", true},
		{"{\"type\":\"integer\"}", "1e0", true},
		{"{\"type\":\"integer\"}", "1e-1", false},
		{"{\"type\":\"integer\"}", "-0", true},
		{"{\"minimum\":-9223372036854775808}", "-9223372036854775808", true},
		{"{\"minimum\":-9223372036854775808}", "-9223372036854775809", false},
		{"{\"maximum\":9223372036854775807}", "9223372036854775807", true},
		{"{\"maximum\":9223372036854775807}", "9223372036854775808", false},
		{"{\"exclusiveMinimum\":-9223372036854775808}", "-9223372036854775808", false},
		{"{\"exclusiveMinimum\":-9223372036854775808}", "-9223372036854775807", true},
		{"{\"exclusiveMaximum\":9223372036854775807}", "9223372036854775807", false},
		{"{\"exclusiveMaximum\":9223372036854775807}", "9223372036854775806", true},
		{"{\"minimum\":9223372036854775808}", "9223372036854775807", false},
		{"{\"maximum\":-9223372036854775809}", "-9223372036854775808", false},
		{"{\"minimum\":-0.5}", "-1", false},
		{"{\"minimum\":-0.5}", "0", true},
		{"{\"maximum\":0.5}", "1", false},
		{"{\"maximum\":0.5}", "0", true},
		{"{\"exclusiveMinimum\":0.5}", "1", true},
		{"{\"exclusiveMaximum\":-0.5}", "-1", true},
		{"{\"minimum\":9007199254740993}", "9007199254740992", false},
		{"{\"minimum\":9007199254740993}", "9007199254740993", true},
		{"{\"maximum\":9007199254740992}", "9007199254740993", false},
		{"{\"type\":\"integer\",\"minimum\":1,\"multipleOf\":0.1}", "1", true},
		{"{\"type\":\"integer\",\"minimum\":-3,\"multipleOf\":2}", "-3", false},
		{"{\"multipleOf\":3}", "-9223372036854775808", false},
		{"{\"multipleOf\":0.1}", "9223372036854775808", true},
		{"{\"multipleOf\":0.3}", "9223372036854775807", false},
		{"{\"multipleOf\":0.3}", "9223372036854775806", true},
	}
	for _, tc := range cases {
		t.Run(tc.schema+"/"+tc.value, func(t *testing.T) {
			compiler := jsonschema.NewCompiler()
			compiler.Draft = jsonschema.Draft7
			if err := compiler.AddResource("https://motai.local/numeric", bytes.NewBufferString(tc.schema)); err != nil {
				t.Fatal(err)
			}
			schema, err := compiler.Compile("https://motai.local/numeric")
			if err != nil {
				t.Fatal(err)
			}
			if valid := schema.Validate(json.Number(tc.value)) == nil; valid != tc.valid {
				t.Fatalf("valid = %v, want %v", valid, tc.valid)
			}
		})
	}
}

func TestPropertyPathsFollowSchemaMutations(t *testing.T) {
	compile := func(source interface{}) *jsonschema.Schema {
		t.Helper()
		data, err := json.Marshal(source)
		if err != nil {
			t.Fatal(err)
		}
		compiler := jsonschema.NewCompiler()
		compiler.Draft = jsonschema.Draft7
		if err := compiler.AddResource("https://motai.local/property-path", bytes.NewReader(data)); err != nil {
			t.Fatal(err)
		}
		schema, err := compiler.Compile("https://motai.local/property-path")
		if err != nil {
			t.Fatal(err)
		}
		return schema
	}
	check := func(schema *jsonschema.Schema, name string, value interface{}, valid bool) {
		t.Helper()
		err := schema.Validate(map[string]interface{}{name: value})
		if (err == nil) != valid {
			t.Fatalf("property %q value %v: err=%v, want valid=%v", name, value, err, valid)
		}
		if err == nil {
			return
		}
		token := url.PathEscape(strings.NewReplacer("~", "~0", "/", "~1").Replace(name))
		instance := ""
		if token != "" {
			instance = "/" + token
		}
		var found bool
		var walk func(*jsonschema.ValidationError)
		walk = func(e *jsonschema.ValidationError) {
			if e.InstanceLocation == instance && e.KeywordLocation == "/properties/"+token+"/type" {
				found = true
			}
			for _, child := range e.Causes {
				walk(child)
			}
		}
		walk(err.(*jsonschema.ValidationError))
		if !found {
			t.Fatalf("property %q lost exact diagnostic paths: %#v", name, err)
		}
	}
	for _, name := range []string{"plain", "a/b~c space#ѩ", ""} {
		t.Run(name, func(t *testing.T) {
			schema := compile(map[string]interface{}{"type": "object", "properties": map[string]interface{}{name: map[string]interface{}{"type": "integer"}}})
			check(schema, name, json.Number("1"), true)
			check(schema, name, "x", false)
			stringSchema := compile(map[string]interface{}{"type": "string"})
			schema.Properties[name] = stringSchema
			check(schema, name, "x", true)
			check(schema, name, json.Number("1"), false)
			renamed := name + "/new~ #ѩ"
			schema.Properties[renamed] = schema.Properties[name]
			delete(schema.Properties, name)
			check(schema, renamed, "x", true)
			check(schema, renamed, json.Number("1"), false)
			check(schema, name, json.Number("1"), true)
			schema.Properties = map[string]*jsonschema.Schema{name: stringSchema}
			check(schema, name, "x", true)
			check(schema, name, json.Number("1"), false)
			delete(schema.Properties, name)
			check(schema, name, json.Number("1"), true)
		})
	}
}

func TestPropertyPathsFollowRefReplacementAndCollapse(t *testing.T) {
	source := "{\"type\":\"object\",\"properties\":{\"a/b~c\":{\"$ref\":\"#/definitions/value\"}},\"definitions\":{\"value\":{\"type\":\"integer\"},\"text\":{\"type\":\"string\"}}}"
	compiler := jsonschema.NewCompiler()
	compiler.Draft = jsonschema.Draft7
	if err := compiler.AddResource("https://motai.local/property-ref", bytes.NewBufferString(source)); err != nil {
		t.Fatal(err)
	}
	schema, err := compiler.Compile("https://motai.local/property-ref")
	if err != nil {
		t.Fatal(err)
	}
	text, err := compiler.Compile("https://motai.local/property-ref#/definitions/text")
	if err != nil {
		t.Fatal(err)
	}
	values := []interface{}{json.Number("1"), "x", nil, true}
	check := func(want []bool) {
		t.Helper()
		for i, value := range values {
			if valid := schema.Validate(map[string]interface{}{"a/b~c": value}) == nil; valid != want[i] {
				t.Fatalf("value %v valid=%v want=%v", value, valid, want[i])
			}
		}
	}
	check([]bool{true, false, false, false})
	schema.Properties["a/b~c"].Ref = text
	check([]bool{false, true, false, false})
	schema = collapseDraft7Refs(schema, map[*jsonschema.Schema]*jsonschema.Schema{})
	check([]bool{false, true, false, false})
	schema.Properties["a/b~c"] = &jsonschema.Schema{Types: []string{"integer"}, MinLength: -1, MaxLength: -1}
	check([]bool{true, false, false, false})
}
