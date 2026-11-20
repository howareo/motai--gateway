package attempt

import (
	"context"
	"errors"
	"time"

	"github.com/QuantumNous/new-api/motai/usage"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
)

func markSucceeded(terminal *Terminal, intent Intent, protocol string) {
	terminal.RequestOutcome = "succeeded"
	terminal.AttemptOutcome = "succeeded"
	terminal.ErrorClass = nil
	if intent.Stream {
		terminal.ProtocolTerminal = "completed"
	}
	if protocol != "" {
		terminal.ProtocolTerminal = protocol
	}
}

func TerminalFromContext(c *gin.Context, intent Intent) Terminal {
	now := time.Now().UTC()
	terminal := Terminal{1, intent.AttemptID, now, now.Sub(intent.StartedAt).Milliseconds(), nil, "failed", "invalid_request", "none", nil, "not_applicable", int64(max(0, c.Writer.Size())), str("invalid_request"), "none", usage.Normalize("unknown", map[string]int64{}, true), nil, nil}
	if value := c.GetString("motai_send_certainty"); value != "" {
		terminal.SendCertainty = value
	}
	if status := c.GetInt("motai_upstream_status"); status > 0 {
		terminal.UpstreamStatus = &status
	}
	if value, ok := c.Get("motai_first_byte"); ok {
		elapsed := value.(time.Time).Sub(intent.StartedAt).Milliseconds()
		if elapsed >= 0 {
			terminal.TTFTMS = &elapsed
		}
	}
	if value, ok := c.Get("motai_usage"); ok {
		terminal.Usage = value.(usage.Record)
	}
	if value, ok := c.Get("motai_provider_usage"); ok {
		terminal.Usage = value.(usage.Record)
	}
	infoValue, _ := c.Get("motai_relay_info")
	info, _ := infoValue.(*relaycommon.RelayInfo)
	protocol := c.GetString("motai_protocol_terminal")
	status := c.GetInt("motai_error_status")
	if terminal.UpstreamStatus != nil && *terminal.UpstreamStatus >= 400 {
		status = *terminal.UpstreamStatus
	}
	health := c.GetString("motai_health_error_class")
	switch {
	case errors.Is(c.Request.Context().Err(), context.Canceled) && protocol == "completed" && status < 400 && terminal.UpstreamStatus != nil && *terminal.UpstreamStatus >= 200 && *terminal.UpstreamStatus <= 299:
		// The responses stream already delivered response.completed (and its usage) to the client. Codex closes the
		// connection right after it, which can cancel the request context before the upstream EOF arrives. The protocol
		// layer has finished, so the late client disconnect does not change the result.
		markSucceeded(&terminal, intent, protocol)
	case errors.Is(c.Request.Context().Err(), context.Canceled):
		terminal.RequestOutcome = "cancelled"
		terminal.AttemptOutcome = "client_gone"
		terminal.ErrorClass = str("client_cancelled")
	case errors.Is(c.Request.Context().Err(), context.DeadlineExceeded):
		terminal.AttemptOutcome = "deadline_exceeded"
		terminal.ErrorClass = str("request_deadline")
	case health == "funds_exhausted" || health == "auth_invalid":
		terminal.AttemptOutcome = health
		terminal.ErrorClass = str(health)
		if protocol == "failed" {
			terminal.ProtocolTerminal = "failed"
		}
	case protocol == "failed":
		terminal.AttemptOutcome = "upstream_failed"
		terminal.ErrorClass = str("unknown_upstream")
		terminal.ProtocolTerminal = "failed"
	case protocol == "incomplete":
		terminal.AttemptOutcome = "incomplete"
		terminal.ErrorClass = str("stream_incomplete")
		terminal.ProtocolTerminal = "incomplete"
	case status == 429:
		terminal.AttemptOutcome = "rate_limited"
		terminal.ErrorClass = str("rate_limited")
		if deadline, ok := c.Get("motai_retry_after_until"); ok {
			if value, valid := deadline.(time.Time); valid {
				terminal.RetryAfterUntil = &value
			}
		}
	case status >= 500:
		terminal.AttemptOutcome = "upstream_rejected"
		terminal.ErrorClass = str("upstream_5xx")
	case status >= 400:
		terminal.AttemptOutcome = "upstream_rejected"
		terminal.ErrorClass = str("unknown_upstream")
	case info != nil && info.IsStream && (info.StreamStatus.HasErrors() || !info.StreamStatus.IsNormalEnd() || (intent.Protocol == "responses" && protocol == "")):
		terminal.AttemptOutcome = "stream_broken"
		terminal.ErrorClass = str("stream_broken")
		terminal.ProtocolTerminal = "missing"
	case info != nil && status == 0 && c.Writer.Status() >= 200 && c.Writer.Status() <= 299 && terminal.UpstreamStatus != nil && *terminal.UpstreamStatus >= 200 && *terminal.UpstreamStatus <= 299:
		markSucceeded(&terminal, intent, protocol)
	case terminal.SendCertainty != "none":
		terminal.AttemptOutcome = "uncertain"
		terminal.ErrorClass = str("upstream_timeout")
	}
	if code := c.GetString("motai_error_code"); code == "bad_response_body" || code == "bad_response" || code == "empty_response" || code == "read_response_body_failed" {
		terminal.RequestOutcome = "failed"
		terminal.AttemptOutcome = "invalid_response"
		terminal.ErrorClass = str("invalid_response")
	}
	// Upstream error text is recorded only for failed attempts; a client disconnect says nothing about the upstream.
	if terminal.AttemptOutcome != "succeeded" && terminal.AttemptOutcome != "client_gone" {
		if detail := c.GetString("motai_error_detail"); detail != "" {
			terminal.ErrorDetail = &detail
		}
	}
	if terminal.AttemptOutcome != "succeeded" {
		for _, count := range []*usage.Count{&terminal.Usage.TotalInput, &terminal.Usage.InputUncached, &terminal.Usage.CacheRead, &terminal.Usage.CacheWrite.TTL5m, &terminal.Usage.CacheWrite.TTL1h, &terminal.Usage.CacheWrite.TTLUnknown, &terminal.Usage.OutputTotal, &terminal.Usage.Reasoning} {
			count.Completeness = "partial"
		}
	}
	return terminal
}
