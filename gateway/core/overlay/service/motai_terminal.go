package service

import (
	"net/http"
	"net/http/httptrace"
	"time"

	"github.com/QuantumNous/new-api/motai/health"
	"github.com/QuantumNous/new-api/motai/nocharge"
	"github.com/QuantumNous/new-api/motai/usage"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
)

// These hooks publish local classifications and numeric counts. The only error text they publish is
// "motai_error_detail": the upstream error message after sanitizeErrorDetail (markup, control characters
// and credential-like strings removed, at most 512 runes). Raw error text is never stored.
func ObserveMotaiTerminal(c *gin.Context, info *relaycommon.RelayInfo, apiErr *types.NewAPIError) {
	if !nocharge.Enabled() {
		return
	}
	c.Set("motai_relay_info", info)
	if apiErr != nil {
		c.Set("motai_error_status", apiErr.StatusCode)
		c.Set("motai_error_code", string(apiErr.GetErrorCode()))
		if detail := sanitizeErrorDetail(apiErr.Error()); detail != "" {
			c.Set("motai_error_detail", detail)
		}
		if c.GetInt("motai_upstream_status") > 0 {
			observeMotaiHealthError(c, apiErr.RelayError)
		}
	}
	if info != nil {
		if session, ok := info.Billing.(*nocharge.Session); ok && session.Usage != nil {
			c.Set("motai_usage", *session.Usage)
		}
	}
}
func TraceMotaiRequest(c *gin.Context, req *http.Request) *http.Request {
	if !nocharge.Enabled() {
		return req
	}
	trace := &httptrace.ClientTrace{
		WroteHeaders: func() { c.Set("motai_send_certainty", "partial") },
		WroteRequest: func(info httptrace.WroteRequestInfo) {
			if info.Err == nil {
				c.Set("motai_send_certainty", "full")
			}
		},
		GotFirstResponseByte: func() { c.Set("motai_first_byte", time.Now()) },
	}
	return req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
}
func ObserveMotaiHTTP(c *gin.Context, resp *http.Response) {
	if nocharge.Enabled() && resp != nil {
		c.Set("motai_upstream_status", resp.StatusCode)
		if resp.StatusCode == http.StatusTooManyRequests {
			if deadline, ok := health.RetryAfter(resp.Header.Values("Retry-After"), time.Now().UTC(), c.GetInt("motai_retry_after_max_seconds")); ok {
				c.Set("motai_retry_after_until", deadline)
			}
		}
	}
}
func ObserveMotaiResponses(c *gin.Context, event string, response *dto.OpenAIResponsesResponse) {
	if !nocharge.Enabled() {
		return
	}
	switch event {
	case "response.completed", "response.done":
		c.Set("motai_protocol_terminal", "completed")
	case "response.failed", "response.error":
		c.Set("motai_protocol_terminal", "failed")
	case "response.incomplete", "response.cancelled", "response.canceled":
		c.Set("motai_protocol_terminal", "incomplete")
	}
	if response == nil {
		return
	}
	switch string(response.Status) {
	case `"completed"`:
		c.Set("motai_protocol_terminal", "completed")
	case `"failed"`:
		c.Set("motai_protocol_terminal", "failed")
	case `"incomplete"`, `"cancelled"`, `"canceled"`:
		c.Set("motai_protocol_terminal", "incomplete")
	}
	if c.GetString("motai_protocol_terminal") == "failed" {
		if failure := response.GetOpenAIError(); failure != nil {
			observeMotaiHealthError(c, *failure)
		}
	}
	if response.Usage != nil {
		u := response.Usage
		counts := map[string]int64{"openai_input_tokens": int64(u.InputTokens), "openai_output_tokens": int64(u.OutputTokens)}
		if u.InputTokensDetails != nil {
			counts["openai_cached_tokens"] = int64(u.InputTokensDetails.CachedTokens)
		}
		c.Set("motai_provider_usage", usage.Normalize("openai", counts, event != "response.completed" && event != "response.done" && string(response.Status) != `"completed"`))
	}
}

func observeMotaiHealthError(c *gin.Context, providerError any) {
	status := c.GetInt("motai_upstream_status")
	var code, kind, message string
	switch failure := providerError.(type) {
	case types.OpenAIError:
		code, _ = failure.Code.(string)
		kind, message = failure.Type, failure.Message
	case types.ClaudeError:
		kind, message = failure.Type, failure.Message
	default:
		return
	}
	if classification := health.Classify(status, code, kind, message); classification != "" {
		c.Set("motai_health_error_class", classification)
	}
}
