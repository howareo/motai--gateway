package controller

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type motaiAccountTransport func(*http.Request) (*http.Response, error)

func (fn motaiAccountTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}
func motaiAccountJSON(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestMotaiAccountSub2ReusesMaintainedParserAcrossAnyPoolVendor(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.Method != "GET" || request.URL.Path != "/prefix/v1/sub2api/billing" || request.Header.Get("Authorization") != "Bearer SYNTHETIC_SECRET" {
			t.Fatalf("unexpected management request")
		}
		return motaiAccountJSON(200, `{"object":"sub2api.key_billing","schema_version":1,"billing_scope":"token","effective_rate_multiplier":0.12,"observed_at":"2026-10-27T00:00:00Z","raw":"PRIVATE_BODY"}`), nil
	})}
	result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid/prefix/v1", "SYNTHETIC_SECRET", client)
	if result.State != "known" || result.Multiplier == nil || *result.Multiplier != 0.12 || calls != 1 {
		t.Fatalf("unexpected observation: %+v", result)
	}
	data, _ := json.Marshal(result)
	if strings.Contains(string(data), "SYNTHETIC") || strings.Contains(string(data), "PRIVATE_BODY") {
		t.Fatal("secret or raw body escaped")
	}
}

func TestMotaiTokenShopDailyCostsUseKeyBillWithoutApplyingCurrentMultiplier(t *testing.T) {
	client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
		if request.Method != "GET" || request.URL.Path != "/v1/usage" || request.Header.Get("Authorization") != "Bearer SYNTHETIC_SECRET" {
			t.Fatal("unexpected bill request")
		}
		return motaiAccountJSON(200, `{"daily_usage":[{"date":"2026-11-16","actual_cost":43.27461468,"cost":393.405588,"requests":2091}],"key":"PRIVATE"}`), nil
	})}
	days := motaiTokenShopDailyCosts(context.Background(), "https://vvvvvip.tststs.shop", "SYNTHETIC_SECRET", client)
	if len(days) != 1 || days[0].ActualCost != 43.27461468 || days[0].StandardCost != 393.405588 || days[0].Requests != 2091 {
		t.Fatalf("unexpected bill: %+v", days)
	}
	if days := motaiTokenShopDailyCosts(context.Background(), "https://other.invalid", "SYNTHETIC_SECRET", client); days != nil {
		t.Fatal("unrelated channel must not fetch a TokenShop bill")
	}
	invalid := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
		return motaiAccountJSON(200, `{"daily_usage":[{"date":"2026-11-16","cost":393,"requests":2091}]}`), nil
	})}
	if days := motaiTokenShopDailyCosts(context.Background(), "https://vvvvvip.tststs.shop", "SYNTHETIC_SECRET", invalid); days != nil {
		t.Fatal("missing cost must not become a zero bill")
	}
}

func TestMotaiAccountNewAPIGroupRatioReusesMaintainedResolution(t *testing.T) {
	for _, group := range []string{"openai", "claude", "xai", "deepseek", "gemini", "moonshot", "zhipu", "custom-pool"} {
		t.Run(group, func(t *testing.T) {
			client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
				switch request.URL.Path {
				case "/v1/sub2api/billing":
					return motaiAccountJSON(404, `{}`), nil
				case "/api/usage/token/":
					return motaiAccountJSON(200, `{"code":true,"data":{"group":"`+group+`"}}`), nil
				case "/api/pricing":
					if request.Header.Get("Authorization") != "" {
						t.Fatal("public pricing sent model key")
					}
					return motaiAccountJSON(200, `{"group_ratio":{"`+group+`":0.24}}`), nil
				default:
					t.Fatal("unexpected request path")
					return nil, errors.New("unexpected")
				}
			})}
			result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid/v1", "SYNTHETIC_SECRET", client)
			if result.State != "known" || result.Multiplier == nil || *result.Multiplier != 0.24 {
				t.Fatalf("group result %+v", result)
			}
		})
	}
}

// Rule change (was TestMotaiAccountGroupMissingNeverDispatchesLegacyInvalidModelFallback).
// Old assertion -> new assertion:
//   - any non-GET request is a test failure          -> exactly one POST is expected, to /v1/messages, with the fixed model
//   - state "unknown", Multiplier nil                -> state "known", Multiplier 0.2, UpstreamGroup "explicit"
//   - calls == 3 (sub2, usage, pricing)              -> 4 requests, one of them the fixed POST
//
// Why: relays such as itkk.lol omit the group from /api/usage/token/, and the old New API resolved it
// from the rejection text of one nonexistent-model POST. Without that step their cost sync fails.
func TestMotaiAccountGroupMissingDispatchesOnlyTheFixedUnknownModelProbe(t *testing.T) {
	client, seen := motaiGroupProbeClient(t, `{"code":true,"data":{"name":"no-match"}}`, func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer SYNTHETIC_SECRET" {
			t.Fatal("group probe lost its channel credential")
		}
		body, _ := io.ReadAll(request.Body)
		var payload map[string]any
		if json.Unmarshal(body, &payload) != nil || payload["model"] != newAPIUnknownModelProbe || len(payload) != 3 {
			t.Fatalf("group probe body is not the fixed shape: %s", body)
		}
		return motaiAccountJSON(403, `{"error":{"message":"no available channel for model x under group explicit (distributor)"}}`), nil
	})
	result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
	if result.State != "known" || result.Multiplier == nil || *result.Multiplier != 0.2 || result.UpstreamGroup != "explicit" || result.ErrorClass != "" {
		t.Fatalf("unexpected observation %+v", result)
	}
	want := []string{"GET /v1/sub2api/billing", "GET /api/usage/token/", "GET /api/pricing", "POST /v1/messages"}
	if strings.Join(*seen, "|") != strings.Join(want, "|") {
		t.Fatalf("request sequence %v", *seen)
	}
}

func TestMotaiAccountGroupProbeIsSkippedWhenUsageNamesTheGroup(t *testing.T) {
	client, seen := motaiGroupProbeClient(t, `{"code":true,"data":{"group":"explicit"}}`, nil)
	result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
	if result.State != "known" || result.UpstreamGroup != "explicit" || len(*seen) != 3 {
		t.Fatalf("observation %+v requests %v", result, *seen)
	}
}

func TestMotaiAccountGroupProbeFailuresStayUnknownAndNeverGuess(t *testing.T) {
	for _, fixture := range []struct {
		name, usage string
		reply       func(*http.Request) (*http.Response, error)
	}{
		{"rejection has no group text", `{"code":true,"data":{"name":"no-match"}}`, func(*http.Request) (*http.Response, error) {
			return motaiAccountJSON(403, `{"error":{"message":"forbidden"}}`), nil
		}},
		{"rejection names a group pricing does not list", `{"code":true,"data":{"name":"no-match"}}`, func(*http.Request) (*http.Response, error) {
			return motaiAccountJSON(403, `{"error":{"message":"under group other (distributor)"}}`), nil
		}},
		{"group text contains parentheses and newline", `{"code":true,"data":{"name":"no-match"}}`, func(*http.Request) (*http.Response, error) {
			return motaiAccountJSON(403, `{"error":{"message":"under group exp(licit)\nx (distributor)"}}`), nil
		}},
		{"transport error", `{"code":true,"data":{"name":"no-match"}}`, func(*http.Request) (*http.Response, error) {
			return nil, errors.New("connection reset")
		}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			client, seen := motaiGroupProbeClient(t, fixture.usage, fixture.reply)
			result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
			if result.State != "unknown" || result.Multiplier != nil || result.UpstreamGroup != "" || result.ErrorClass != "group_unresolved" {
				t.Fatalf("observation %+v", result)
			}
			if posts := motaiCount(*seen, "POST /v1/messages"); posts > 1 {
				t.Fatalf("group probe was retried: %d", posts)
			}
		})
	}
}

func TestMotaiAccountGroupProbeAcceptedByUpstreamIsAFailure(t *testing.T) {
	// A 2xx means the relay really accepted a model request. Even a direct ratio in the usage
	// payload, which the maintained code would otherwise use, must not turn that into a result.
	usage := `{"code":true,"data":{"name":"no-match","group_ratio":0.3}}`
	for _, body := range []string{`{"id":"x"}`, `{"error":{"message":"under group explicit (distributor)"}}`} {
		client, _ := motaiGroupProbeClient(t, usage, func(*http.Request) (*http.Response, error) { return motaiAccountJSON(200, body), nil })
		result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
		if result.State != "unknown" || result.Multiplier != nil || result.UpstreamGroup != "" || result.ErrorClass != "group_unresolved" {
			t.Fatalf("accepted model request produced %+v", result)
		}
	}
}

func TestMotaiManagementTransportBlocksEveryOtherNonGet(t *testing.T) {
	const target = "https://upstream.invalid/v1/messages"
	good := `{"model":"` + newAPIUnknownModelProbe + `","max_tokens":1,"messages":[{"role":"user","content":"probe"}]}`
	for _, fixture := range []struct{ name, method, url, body string }{
		{"other path", "POST", "https://upstream.invalid/v1/chat/completions", good},
		{"other host", "POST", "https://other.invalid/v1/messages", good},
		{"other model", "POST", target, strings.Replace(good, newAPIUnknownModelProbe, "gpt-4o", 1)},
		{"extra field", "POST", target, strings.Replace(good, `"max_tokens":1`, `"max_tokens":1,"stream":true`, 1)},
		{"missing field", "POST", target, `{"model":"` + newAPIUnknownModelProbe + `","max_tokens":1}`},
		{"not json", "POST", target, "x"},
		{"oversized", "POST", target, good + strings.Repeat(" ", 2000)},
		{"put", "PUT", target, good},
		{"patch", "PATCH", target, good},
		{"delete", "DELETE", target, ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			calls := 0
			transport := &motaiManagementTransport{groupProbeURL: target, next: motaiAccountTransport(func(*http.Request) (*http.Response, error) {
				calls++
				return motaiAccountJSON(403, `{}`), nil
			})}
			request, err := http.NewRequest(fixture.method, fixture.url, strings.NewReader(fixture.body))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := transport.RoundTrip(request); err == nil || err.Error() != "management_get_only" || calls != 0 {
				t.Fatalf("not blocked: err=%v calls=%d", err, calls)
			}
		})
	}
	t.Run("body without GetBody and disabled transport", func(t *testing.T) {
		calls := 0
		next := motaiAccountTransport(func(*http.Request) (*http.Response, error) { calls++; return motaiAccountJSON(403, `{}`), nil })
		request, _ := http.NewRequest("POST", target, io.NopCloser(strings.NewReader(good)))
		if _, err := (&motaiManagementTransport{groupProbeURL: target, next: next}).RoundTrip(request); err == nil {
			t.Fatal("request whose body cannot be re-read was allowed")
		}
		request, _ = http.NewRequest("POST", target, strings.NewReader(good))
		if _, err := (&motaiManagementTransport{next: next}).RoundTrip(request); err == nil || calls != 0 {
			t.Fatal("transport without a group probe URL allowed a POST")
		}
	})
	t.Run("only one probe per transport, 2xx is recorded", func(t *testing.T) {
		status := 403
		calls := 0
		transport := &motaiManagementTransport{groupProbeURL: target, next: motaiAccountTransport(func(*http.Request) (*http.Response, error) {
			calls++
			return motaiAccountJSON(status, `{}`), nil
		})}
		send := func() error {
			request, _ := http.NewRequest("POST", target, strings.NewReader(good))
			_, err := transport.RoundTrip(request)
			return err
		}
		if err := send(); err != nil || calls != 1 || transport.groupProbeAccepted.Load() {
			t.Fatalf("first probe: err=%v calls=%d accepted=%v", err, calls, transport.groupProbeAccepted.Load())
		}
		if err := send(); err == nil || calls != 1 {
			t.Fatal("second probe was allowed")
		}
		status = 200
		fresh := &motaiManagementTransport{groupProbeURL: target, next: transport.next}
		request, _ := http.NewRequest("POST", target, strings.NewReader(good))
		if _, err := fresh.RoundTrip(request); err != nil || !fresh.groupProbeAccepted.Load() {
			t.Fatal("2xx answer was not recorded")
		}
	})
}

func TestMotaiAccountBillingErrorClassesAreLocalEnumValues(t *testing.T) {
	for _, fixture := range []struct {
		name         string
		sub2, usage  int
		state, class string
	}{
		{"usage unauthorized", 404, 401, "unknown", "unauthorized"},
		{"usage forbidden", 404, 403, "unknown", "unauthorized"},
		{"usage rate limited", 404, 429, "unknown", "probe_rate_limited"},
		{"usage server error", 404, 500, "unknown", "http_5xx"},
		{"usage other client error", 404, 400, "unknown", "http_4xx"},
		{"usage missing", 404, 404, "unsupported", "endpoint_unsupported"},
		{"sub2 client error stops the chain", 400, 200, "unknown", "http_4xx"},
		{"sub2 server error stops the chain", 502, 200, "unknown", "http_5xx"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
				switch request.URL.Path {
				case "/v1/sub2api/billing":
					return motaiAccountJSON(fixture.sub2, `{}`), nil
				case "/api/usage/token/":
					return motaiAccountJSON(fixture.usage, `{}`), nil
				}
				t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
				return nil, errors.New("unexpected")
			})}
			result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
			if result.State != fixture.state || result.ErrorClass != fixture.class || result.Multiplier != nil || result.UpstreamGroup != "" {
				t.Fatalf("observation %+v", result)
			}
			if !motaiProbeErrorClasses[result.ErrorClass] {
				t.Fatalf("class %q is not in the contract enum", result.ErrorClass)
			}
		})
	}
	for _, class := range []string{"", "made up", "under group x (distributor)", "HTTP_5XX"} {
		if motaiNormalizeErrorClass(class) != motaiProbeErrorUnclassified {
			t.Fatalf("%q was not normalized", class)
		}
	}
	if motaiNormalizeErrorClass("timeout") != "timeout" {
		t.Fatal("known class changed")
	}
}

func TestMotaiAccountUpstreamGroupIsBoundedBeforeItLeavesTheProcess(t *testing.T) {
	long := strings.Repeat("g", motaiMaxUpstreamGroupRunes+1)
	for group, want := range map[string]string{
		"国模":       "国模",
		" padded ": "padded",
		strings.Repeat("好", motaiMaxUpstreamGroupRunes): strings.Repeat("好", motaiMaxUpstreamGroupRunes),
		long:          "",
		"a\nb":        "",
		"a\x00b":      "",
		"a\u0085b":    "",
		"bad\xffutf8": "",
		"   ":         "",
	} {
		if got := motaiSanitizeUpstreamGroup(group); got != want {
			t.Fatalf("%q -> %q, want %q", group, got, want)
		}
	}
	// A matching but unsafe pricing key still yields a known multiplier, without a group.
	client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case "/v1/sub2api/billing":
			return motaiAccountJSON(404, `{}`), nil
		case "/api/usage/token/":
			return motaiAccountJSON(200, `{"code":true,"data":{"group":"bad\u0001group"}}`), nil
		}
		return motaiAccountJSON(200, `{"group_ratio":{"bad\u0001group":0.3}}`), nil
	})}
	result := MotaiAccountProbeWithClient(context.Background(), "billing", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
	if result.State != "known" || result.Multiplier == nil || *result.Multiplier != 0.3 || result.UpstreamGroup != "" {
		t.Fatalf("observation %+v", result)
	}
}

func motaiCount(values []string, wanted string) int {
	count := 0
	for _, value := range values {
		if value == wanted {
			count++
		}
	}
	return count
}

// motaiGroupProbeClient serves a New API relay that has no sub2 billing endpoint, answers
// /api/usage/token/ with usage and lists one group ratio. Requests are recorded as "METHOD path";
// post answers the group probe, and a nil post makes any POST a test failure.
func motaiGroupProbeClient(t *testing.T, usage string, post func(*http.Request) (*http.Response, error)) (*http.Client, *[]string) {
	t.Helper()
	seen := []string{}
	client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
		seen = append(seen, request.Method+" "+request.URL.Path)
		switch {
		case request.Method == "GET" && request.URL.Path == "/v1/sub2api/billing":
			return motaiAccountJSON(404, `{}`), nil
		case request.Method == "GET" && request.URL.Path == "/api/usage/token/":
			return motaiAccountJSON(200, usage), nil
		case request.Method == "GET" && request.URL.Path == "/api/pricing":
			return motaiAccountJSON(200, `{"group_ratio":{"explicit":0.2}}`), nil
		case request.Method == "POST" && request.URL.Path == "/v1/messages" && post != nil:
			return post(request)
		}
		t.Fatalf("unexpected request %s %s", request.Method, request.URL.Path)
		return nil, errors.New("unexpected")
	})}
	return client, &seen
}

func TestMotaiAccountWalletQuotaAndCurrency(t *testing.T) {
	for _, fixture := range []struct {
		name, usage, status, state string
		balance                    float64
		currency                   string
	}{
		{"known-zero", `{"code":true,"data":{"total_available":0}}`, `{"data":{"quota_per_unit":500000,"custom_currency_symbol":"$"}}`, "known", 0, ""},
		{"finite-account-cap", `{"code":true,"data":{"total_available":1000000,"user_quota":{"total_available":500000}}}`, `{"data":{"quota_per_unit":500000,"currency":"CNY"}}`, "known", 1, "CNY"},
		{"unlimited-account", `{"code":true,"data":{"unlimited_quota":true,"total_available":0,"user_quota":{"total_available":2000000}}}`, `{"data":{"quota_per_unit":500000}}`, "known", 4, ""},
		{"unlimited-not-money", `{"code":true,"data":{"unlimited_quota":true,"total_available":0}}`, `{"data":{"quota_per_unit":500000}}`, "unknown", 0, ""},
		{"missing-not-zero", `{"code":true,"data":{}}`, `{"data":{"quota_per_unit":500000}}`, "unknown", 0, ""},
		{"bad-unit", `{"code":true,"data":{"total_available":1000000}}`, `{"data":{"quota_per_unit":0}}`, "unknown", 0, ""},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/api/usage/token/" {
					return motaiAccountJSON(200, fixture.usage), nil
				}
				if request.URL.Path != "/api/status" || request.Header.Get("Authorization") != "" {
					t.Fatal("unexpected status request")
				}
				return motaiAccountJSON(200, fixture.status), nil
			})}
			result := MotaiAccountProbeWithClient(context.Background(), "wallet", "https://upstream.invalid/v1", "SYNTHETIC_SECRET", client)
			if result.State != fixture.state {
				t.Fatalf("state=%s", result.State)
			}
			if fixture.state == "known" && (result.Balance == nil || *result.Balance != fixture.balance) {
				t.Fatalf("wrong balance %+v", result)
			}
			if fixture.state == "unknown" && result.Balance != nil {
				t.Fatal("unknown rendered money")
			}
			if fixture.currency == "" && result.Currency != nil {
				t.Fatal("ambiguous currency guessed")
			}
			if fixture.currency != "" && (result.Currency == nil || *result.Currency != fixture.currency) {
				t.Fatal("explicit ISO currency lost")
			}
		})
	}
}

func TestMotaiAccountWalletDashboardFallbackOnlyAfterUnsupportedUsage(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: motaiAccountTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		switch request.URL.Path {
		case "/api/usage/token/":
			return motaiAccountJSON(404, `{}`), nil
		case "/v1/dashboard/billing/subscription":
			return motaiAccountJSON(200, `{"object":"billing_subscription","hard_limit_usd":10}`), nil
		case "/v1/dashboard/billing/usage":
			return motaiAccountJSON(200, `{"object":"list","total_usage":200}`), nil
		default:
			t.Fatal("unexpected path")
			return nil, errors.New("unexpected")
		}
	})}
	result := MotaiAccountProbeWithClient(context.Background(), "wallet", "https://upstream.invalid/v1", "SYNTHETIC_SECRET", client)
	if result.State != "known" || result.Balance == nil || *result.Balance != 8 || result.Currency != nil || calls != 3 {
		t.Fatalf("unexpected dashboard result %+v", result)
	}
}

func TestMotaiAccountProbeFailuresAreBoundedAndSanitized(t *testing.T) {
	for _, fixture := range []struct {
		name     string
		response *http.Response
		state    string
	}{
		{"unauthorized", motaiAccountJSON(401, `PRIVATE_BODY`), "unknown"},
		{"redirect", &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://other.invalid/MODEL_SECRET"}}, Body: io.NopCloser(strings.NewReader("PRIVATE_BODY"))}, "unknown"},
		{"oversized", motaiAccountJSON(200, strings.Repeat("x", 65537)), "unknown"},
		{"unsupported", motaiAccountJSON(404, `{}`), "unsupported"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: motaiAccountTransport(func(*http.Request) (*http.Response, error) { calls++; return fixture.response, nil })}
			result := MotaiAccountProbeWithClient(context.Background(), "wallet", "https://upstream.invalid", "SYNTHETIC_SECRET", client)
			if result.State != fixture.state || result.Balance != nil || calls > 2 {
				t.Fatalf("unexpected failure observation %+v calls=%d", result, calls)
			}
		})
	}
	client := &http.Client{Transport: motaiAccountTransport(func(*http.Request) (*http.Response, error) { t.Fatal("invalid target dispatched"); return nil, nil })}
	for _, target := range []string{"http://upstream.invalid", "https://user:pass@upstream.invalid", "https://upstream.invalid?token=PRIVATE", "invalid"} {
		if MotaiAccountProbeWithClient(context.Background(), "wallet", target, "SYNTHETIC_SECRET", client).State != "unknown" {
			t.Fatal("invalid target accepted")
		}
	}
}
