package controller

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/service"
)

// MotaiAccountObservation is the complete management response whitelist.
// It never carries an upstream body, error text, key or database channel ID.
// ErrorClass and UpstreamGroup are billing-only. ErrorClass is one of the local
// enum values in motaiProbeErrorClasses, never upstream text. UpstreamGroup is
// the single upstream-derived string: a pricing group key that was matched,
// bounded and stripped of control characters by motaiSanitizeUpstreamGroup.
type MotaiAccountObservation struct {
	State         string
	Multiplier    *float64
	Balance       *float64
	Currency      *string
	ErrorClass    string
	UpstreamGroup string
	DailyCosts    []MotaiDailyCost
}

type MotaiDailyCost struct {
	Date         string  `json:"date"`
	ActualCost   float64 `json:"actualCost"`
	StandardCost float64 `json:"standardCost"`
	Requests     int64   `json:"requests"`
}

const motaiProbeErrorUnclassified = "probe_failed"

// motaiProbeErrorClasses is every class the maintained probe code can report,
// plus motaiProbeErrorUnclassified. It must match the error_class enum of
// billing_probe_response in contracts/v1/internal-api.schema.json.
var motaiProbeErrorClasses = map[string]bool{
	"unauthorized": true, "probe_rate_limited": true, "group_unresolved": true,
	"endpoint_unsupported": true, "channel_type_unsupported": true, "channel_proxy_unsupported": true,
	"key_unavailable": true, "invalid_target": true, "target_blocked": true,
	"dns_error": true, "tls_error": true, "timeout": true, "network_error": true,
	"redirect_blocked": true, "http_4xx": true, "http_5xx": true,
	"bad_content_type": true, "response_too_large": true, "response_read_error": true,
	"schema_invalid": true, "value_out_of_band": true, motaiProbeErrorUnclassified: true,
}

func motaiNormalizeErrorClass(class string) string {
	if motaiProbeErrorClasses[class] {
		return class
	}
	return motaiProbeErrorUnclassified
}

const motaiMaxUpstreamGroupRunes = 128

// motaiSanitizeUpstreamGroup returns "" for anything that must not leave the
// process: empty, invalid UTF-8, over-long or containing control characters.
func motaiSanitizeUpstreamGroup(group string) string {
	group = strings.TrimSpace(group)
	if group == "" || !utf8.ValidString(group) || utf8.RuneCountInString(group) > motaiMaxUpstreamGroupRunes {
		return ""
	}
	for _, r := range group {
		if unicode.IsControl(r) {
			return ""
		}
	}
	return group
}

// motaiManagementTransport keeps management probes read-only. Every request
// must be a GET, with exactly one exception: the legacy "unknown model" group
// probe that the maintained New API resolver sends when /api/usage/token/ does
// not name the token's group (some relays omit it, for example itkk.lol). That
// request is allowed only as one fixed shape: POST to groupProbeURL, a body of
// exactly {model: newAPIUnknownModelProbe, max_tokens, messages}, once per
// probe. The model is deliberately nonexistent, so a relay rejects it and its
// rejection text names the group. Anything else that is not a GET stays blocked
// with management_get_only; the exception is not a general POST allowance.
// If the relay answers that POST with 2xx it actually accepted a model request,
// which is never wanted: groupProbeAccepted records it and the caller reports
// the whole probe as failed.
type motaiManagementTransport struct {
	next               http.RoundTripper
	groupProbeURL      string
	groupProbeUsed     atomic.Bool
	groupProbeAccepted atomic.Bool
}

func (t *motaiManagementTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.Method == http.MethodGet {
		return t.next.RoundTrip(request)
	}
	if !t.claimGroupProbe(request) {
		return nil, errors.New("management_get_only")
	}
	response, err := t.next.RoundTrip(request)
	if err == nil && response.StatusCode >= 200 && response.StatusCode < 300 {
		t.groupProbeAccepted.Store(true)
	}
	return response, err
}

// claimGroupProbe reports whether request is the one allowed group probe and,
// if so, consumes the single allowance.
func (t *motaiManagementTransport) claimGroupProbe(request *http.Request) bool {
	if t.groupProbeURL == "" || request.Method != http.MethodPost || request.URL.String() != t.groupProbeURL || request.GetBody == nil {
		return false
	}
	body, err := request.GetBody()
	if err != nil {
		return false
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, 1025))
	if err != nil || len(data) > 1024 {
		return false
	}
	var payload map[string]any
	if common.Unmarshal(data, &payload) != nil || len(payload) != 3 {
		return false
	}
	if name, _ := payload["model"].(string); name != newAPIUnknownModelProbe {
		return false
	}
	if _, ok := payload["max_tokens"]; !ok {
		return false
	}
	if _, ok := payload["messages"]; !ok {
		return false
	}
	return t.groupProbeUsed.CompareAndSwap(false, true)
}

func MotaiAccountProbe(ctx context.Context, kind, baseURL, secret string) MotaiAccountObservation {
	return MotaiAccountProbeWithClient(ctx, kind, baseURL, secret, service.NewStrictProtectedFetchHTTPClient(sub2BillingProbeTimeout))
}

func MotaiAccountProbeWithClient(ctx context.Context, kind, baseURL, secret string, client *http.Client) MotaiAccountObservation {
	unknown := MotaiAccountObservation{State: "unknown"}
	u, err := url.Parse(baseURL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.TrimSpace(secret) == "" {
		return unknown
	}
	if kind != "billing" && kind != "wallet" {
		return unknown
	}
	ctx, cancel := context.WithTimeout(ctx, sub2BillingProbeTimeout)
	defer cancel()
	copyClient := *client
	transport := copyClient.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	// One transport per probe: the group-probe allowance is per call, never shared.
	management := &motaiManagementTransport{next: transport}
	if target, class := buildNewAPIProbeURL(baseURL, newAPIMessagesPath); class == "" && target != nil {
		management.groupProbeURL = target.String()
	}
	copyClient.Transport = management
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	// Compatibility-only temporary object. It never enters old SQL/key caches.
	// A fixed compatible type removes the old vendor allowlist from eligibility.
	channel := &model.Channel{Type: constant.ChannelTypeOpenAI, BaseURL: &baseURL, Key: secret}
	if kind == "billing" {
		result := executeSub2BillingProbeWithClient(ctx, channel, &copyClient)
		if result.Status == "unsupported" && result.ErrorClass == "endpoint_unsupported" {
			result = executeNewAPIPricingProbeWithClient(ctx, channel, &copyClient)
		}
		if management.groupProbeAccepted.Load() {
			// The relay accepted the nonexistent-model request. Whatever ratio the
			// maintained code derived afterwards (it can fall back to a direct
			// ratio) is not trusted: report failure and take no group from it.
			return MotaiAccountObservation{State: "unknown", ErrorClass: "group_unresolved"}
		}
		if result.Status == "ok" && result.EffectiveRateMultiplier != nil {
			return MotaiAccountObservation{State: "known", Multiplier: result.EffectiveRateMultiplier,
				UpstreamGroup: motaiSanitizeUpstreamGroup(result.UpstreamGroup),
				DailyCosts:    motaiTokenShopDailyCosts(ctx, baseURL, secret, &copyClient)}
		}
		if result.Status == "unsupported" {
			return MotaiAccountObservation{State: "unsupported", ErrorClass: motaiNormalizeErrorClass(result.ErrorClass)}
		}
		return MotaiAccountObservation{State: "unknown", ErrorClass: motaiNormalizeErrorClass(result.ErrorClass)}
	}
	// Reuse the maintained fixed-path fetch, numeric helpers and the same quota
	// calculation as WalletService. Unlimited token quota is never account money.
	usageURL, code := buildWalletProbeURL(baseURL, "/api/usage/token/")
	if code != "" {
		return unknown
	}
	usage := fetchNewAPIJSON(ctx, &copyClient, usageURL, secret)
	if usage.errorClass == "endpoint_unsupported" {
		legacy := executeWalletProbeWithClient(ctx, channel, &copyClient)
		if legacy.Status == "ok" {
			return MotaiAccountObservation{State: "known", Balance: legacy.Balance, Currency: motaiKnownCurrency(u.Hostname())}
		}
		if legacy.Status == "unsupported" {
			return MotaiAccountObservation{State: "unsupported"}
		}
		return unknown
	}
	if usage.errorClass != "" {
		return unknown
	}
	var usagePayload map[string]any
	if common.Unmarshal(usage.body, &usagePayload) != nil {
		return unknown
	}
	statusURL, code := buildWalletProbeURL(baseURL, "/api/status")
	if code != "" {
		return unknown
	}
	status := fetchNewAPIJSON(ctx, &copyClient, statusURL, "")
	if status.errorClass != "" {
		return unknown
	}
	var statusPayload map[string]any
	if common.Unmarshal(status.body, &statusPayload) != nil {
		return unknown
	}
	balance, ok := motaiRelayQuotaBalance(usagePayload, statusPayload)
	if !ok {
		return unknown
	}
	return MotaiAccountObservation{State: "known", Balance: &balance, Currency: motaiProbeCurrency(statusPayload, u.Hostname())}
}

// The bill already includes service tiers and group changes; never infer it from the current discount.
func motaiTokenShopDailyCosts(ctx context.Context, baseURL, secret string, client *http.Client) []MotaiDailyCost {
	u, err := url.Parse(baseURL)
	if err != nil {
		return nil
	}
	switch strings.ToLower(u.Hostname()) {
	case "vvvvvip.tststs.shop", "tokenshop.homes", "api.tokenshop.homes":
	default:
		return nil
	}
	target, code := buildWalletProbeURL(baseURL, "/v1/usage")
	if code != "" {
		return nil
	}
	response := fetchNewAPIJSON(ctx, client, target, secret)
	if response.errorClass != "" {
		return nil
	}
	var payload struct {
		Days []struct {
			Date     string   `json:"date"`
			Actual   *float64 `json:"actual_cost"`
			Standard *float64 `json:"cost"`
			Requests *int64   `json:"requests"`
		} `json:"daily_usage"`
	}
	if common.Unmarshal(response.body, &payload) != nil || len(payload.Days) == 0 || len(payload.Days) > 90 {
		return nil
	}
	days := make([]MotaiDailyCost, 0, len(payload.Days))
	seen := make(map[string]bool)
	for _, day := range payload.Days {
		date, err := time.Parse("2006-01-02", day.Date)
		if err != nil || date.Format("2006-01-02") != day.Date || seen[day.Date] || day.Actual == nil || day.Standard == nil || day.Requests == nil ||
			math.IsNaN(*day.Actual) || math.IsInf(*day.Actual, 0) || *day.Actual < 0 || math.IsNaN(*day.Standard) || math.IsInf(*day.Standard, 0) || *day.Standard < 0 || *day.Requests < 0 {
			return nil
		}
		seen[day.Date] = true
		days = append(days, MotaiDailyCost{day.Date, *day.Actual, *day.Standard, *day.Requests})
	}
	return days
}

func motaiRelayQuotaBalance(usage, status map[string]any) (float64, bool) {
	if success, ok := usage["code"].(bool); !ok || !success {
		return 0, false
	}
	data := mapFromProbeValue(usage["data"])
	if data == nil {
		return 0, false
	}
	remaining, hasRemaining := probeNumber(data["total_available"])
	account, hasAccount := probeNumber(mapFromProbeValue(data["user_quota"])["total_available"])
	if unlimited, _ := data["unlimited_quota"].(bool); unlimited {
		if !hasAccount {
			return 0, false
		}
		remaining, hasRemaining = account, true
	} else if hasAccount && hasRemaining {
		remaining = math.Min(remaining, account)
	}
	unit, ok := probeNumber(mapFromProbeValue(status["data"])["quota_per_unit"])
	if !hasRemaining || !ok || remaining < 0 || unit <= 0 {
		return 0, false
	}
	balance := remaining / unit
	return balance, !math.IsNaN(balance) && !math.IsInf(balance, 0) && math.Abs(balance) <= 1e12
}

func motaiKnownCurrency(host string) *string {
	// Same confirmed currency facts as Node WalletService; '$' alone is ambiguous.
	switch strings.ToLower(host) {
	case "api.ej2075.com", "api.tokenshop.homes", "tokenshop.homes", "www.sevnx.one", "sevnx.one", "api.aijws.com", "www.rightapi.ai", "rightapi.ai", "downstream.jbbtoken.cn":
		value := "USD"
		return &value
	}
	return nil
}

func motaiProbeCurrency(status map[string]any, host string) *string {
	for _, object := range probeObjectCandidates(status) {
		for _, key := range []string{"currency", "currency_code", "quota_currency"} {
			value, ok := object[key].(string)
			if !ok || len(value) != 3 {
				continue
			}
			valid := true
			for _, letter := range value {
				if letter < 'A' || letter > 'Z' {
					valid = false
				}
			}
			if valid {
				return &value
			}
		}
	}
	return motaiKnownCurrency(host)
}
