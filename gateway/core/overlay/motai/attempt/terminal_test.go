package attempt

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/usage"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestTerminalSuccessUsesObservedStatusAndProtocol(t *testing.T) {
	for _, test := range []struct {
		name         string
		stream       bool
		protocol     string
		upstream     int
		apiCode      string
		want         string
		wantProtocol string
	}{
		{"nonstream-json", false, "", 200, "", "succeeded", "not_applicable"},
		{"nonstream-responses-completed", false, "completed", 200, "", "succeeded", "completed"},
		{"nonstream-semantic-failed", false, "failed", 200, "", "upstream_failed", "failed"},
		{"nonstream-semantic-incomplete", false, "incomplete", 200, "", "incomplete", "incomplete"},
		{"nonstream-no-upstream-observation", false, "", 0, "", "invalid_request", "not_applicable"},
		{"nonstream-redirect", false, "", 302, "", "invalid_request", "not_applicable"},
		{"nonstream-invalid-json", false, "", 200, "bad_response_body", "invalid_response", "not_applicable"},
		{"stream-completed", true, "completed", 200, "", "succeeded", "completed"},
		{"stream-missing-terminal", true, "", 200, "", "stream_broken", "missing"},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
			info := &relaycommon.RelayInfo{IsStream: test.stream, StreamStatus: relaycommon.NewStreamStatus()}
			info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonDone, nil)
			c.Set("motai_relay_info", info)
			c.Set("motai_upstream_status", test.upstream)
			c.Set("motai_protocol_terminal", test.protocol)
			c.Set("motai_error_code", test.apiCode)
			intent := Intent{Protocol: "responses", Stream: test.stream, StartedAt: time.Now().UTC().Add(-time.Second)}
			got := TerminalFromContext(c, intent)
			require.Equal(t, test.want, got.AttemptOutcome)
			require.Equal(t, test.wantProtocol, got.ProtocolTerminal)
			if got.AttemptOutcome != "succeeded" {
				require.NotEqual(t, "succeeded", got.RequestOutcome)
			}
		})
	}
}

func canceledResponsesContext(protocol string, upstream int) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil).WithContext(ctx)
	info := &relaycommon.RelayInfo{IsStream: true, StreamStatus: relaycommon.NewStreamStatus()}
	info.StreamStatus.SetEndReason(relaycommon.StreamEndReasonClientGone, nil)
	c.Set("motai_relay_info", info)
	c.Set("motai_upstream_status", upstream)
	if upstream >= 400 {
		c.Set("motai_error_status", upstream)
	}
	if protocol != "" {
		c.Set("motai_protocol_terminal", protocol)
	}
	return c
}

func TestTerminalCompletedThenClientCloseStaysSucceeded(t *testing.T) {
	intent := Intent{Protocol: "responses", Stream: true, StartedAt: time.Now().UTC().Add(-time.Second)}
	t.Run("completed before the client closed is a success with final usage", func(t *testing.T) {
		c := canceledResponsesContext("completed", 200)
		// ObserveMotaiUsage marks usage partial when the context is canceled; the completed event's usage wins.
		c.Set("motai_usage", usage.Normalize("openai", map[string]int64{"openai_input_tokens": 1}, true))
		c.Set("motai_provider_usage", usage.Normalize("openai", map[string]int64{"openai_input_tokens": 191782, "openai_output_tokens": 40, "openai_cached_tokens": 0}, false))
		got := TerminalFromContext(c, intent)
		require.Equal(t, "succeeded", got.RequestOutcome)
		require.Equal(t, "succeeded", got.AttemptOutcome)
		require.Nil(t, got.ErrorClass)
		require.Equal(t, "completed", got.ProtocolTerminal)
		require.Equal(t, "final", got.Usage.TotalInput.Completeness)
		require.NotNil(t, got.Usage.TotalInput.Value)
		require.EqualValues(t, 191782, *got.Usage.TotalInput.Value)
	})
	t.Run("no protocol terminal is still a real mid-stream disconnect", func(t *testing.T) {
		got := TerminalFromContext(canceledResponsesContext("", 200), intent)
		require.Equal(t, "cancelled", got.RequestOutcome)
		require.Equal(t, "client_gone", got.AttemptOutcome)
		require.Equal(t, "client_cancelled", *got.ErrorClass)
		require.Equal(t, "partial", got.Usage.TotalInput.Completeness)
	})
	for _, protocol := range []string{"incomplete", "failed"} {
		t.Run(protocol+" keeps the cancellation outcome", func(t *testing.T) {
			got := TerminalFromContext(canceledResponsesContext(protocol, 200), intent)
			require.Equal(t, "cancelled", got.RequestOutcome)
			require.Equal(t, "client_gone", got.AttemptOutcome)
			require.Equal(t, "client_cancelled", *got.ErrorClass)
		})
	}
	t.Run("completed with an upstream 500 is not a success", func(t *testing.T) {
		got := TerminalFromContext(canceledResponsesContext("completed", 500), intent)
		require.NotEqual(t, "succeeded", got.RequestOutcome)
		require.NotEqual(t, "succeeded", got.AttemptOutcome)
		require.Equal(t, "client_gone", got.AttemptOutcome)
	})
	t.Run("completed without an upstream status is not a success", func(t *testing.T) {
		got := TerminalFromContext(canceledResponsesContext("completed", 0), intent)
		require.Equal(t, "client_gone", got.AttemptOutcome)
	})
	t.Run("deadline exceeded is not affected", func(t *testing.T) {
		c := canceledResponsesContext("completed", 200)
		ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
		defer cancel()
		c.Request = c.Request.WithContext(ctx)
		got := TerminalFromContext(c, intent)
		require.Equal(t, "deadline_exceeded", got.AttemptOutcome)
	})
}

func TestTerminalHealthObservationDoesNotOverrideClientCancellation(t *testing.T) {
	for _, classification := range []string{"funds_exhausted", "auth_invalid"} {
		t.Run(classification, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			c.Request = httptest.NewRequest("POST", "/v1/responses", nil).WithContext(ctx)
			c.Set("motai_upstream_status", 403)
			c.Set("motai_health_error_class", classification)
			got := TerminalFromContext(c, Intent{StartedAt: time.Now().UTC()})
			require.Equal(t, "client_gone", got.AttemptOutcome)
			require.Equal(t, "client_cancelled", *got.ErrorClass)
		})
	}
}

func TestTerminalHealthAndRetryAfterRemainPrivateObservations(t *testing.T) {
	for _, classification := range []string{"funds_exhausted", "auth_invalid"} {
		t.Run(classification, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
			c.Set("motai_upstream_status", 200)
			c.Set("motai_health_error_class", classification)
			c.Set("motai_protocol_terminal", "failed")
			got := TerminalFromContext(c, Intent{StartedAt: time.Now().UTC()})
			require.Equal(t, classification, got.AttemptOutcome)
			require.Equal(t, "failed", got.RequestOutcome)
			require.Equal(t, "failed", got.ProtocolTerminal)
		})
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	deadline := time.Now().Add(time.Minute)
	c.Set("motai_upstream_status", 429)
	c.Set("motai_retry_after_until", deadline)
	got := TerminalFromContext(c, Intent{StartedAt: time.Now().UTC()})
	require.Equal(t, "rate_limited", got.AttemptOutcome)
	require.Equal(t, &deadline, got.RetryAfterUntil)
	data, err := common.Marshal(got)
	require.NoError(t, err)
	require.NotContains(t, string(data), "RetryAfter")
	require.NotContains(t, string(data), "retry_after")
}

func terminalDetailContext(status int, protocol string, detail string) *gin.Context {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	c.Set("motai_upstream_status", status)
	if status >= 400 {
		c.Set("motai_error_status", status)
	}
	if protocol != "" {
		c.Set("motai_protocol_terminal", protocol)
	}
	if detail != "" {
		c.Set("motai_error_detail", detail)
	}
	return c
}

func TestTerminalErrorDetailOnlyOnUpstreamFailure(t *testing.T) {
	intent := Intent{Protocol: "chat_completions", StartedAt: time.Now().UTC()}
	t.Run("failed attempt keeps detail", func(t *testing.T) {
		for _, status := range []int{400, 402, 429, 502} {
			got := TerminalFromContext(terminalDetailContext(status, "", "余额不足"), intent)
			require.NotNil(t, got.ErrorDetail, status)
			require.Equal(t, "余额不足", *got.ErrorDetail)
			data, err := common.Marshal(got)
			require.NoError(t, err)
			require.Contains(t, string(data), `"error_detail":"余额不足"`)
		}
	})
	t.Run("failed attempt without text omits the field", func(t *testing.T) {
		got := TerminalFromContext(terminalDetailContext(502, "", ""), intent)
		require.Nil(t, got.ErrorDetail)
		data, err := common.Marshal(got)
		require.NoError(t, err)
		require.NotContains(t, string(data), "error_detail")
	})
	t.Run("success never carries detail", func(t *testing.T) {
		c := terminalDetailContext(200, "", "stale text from an earlier failure")
		info := &relaycommon.RelayInfo{StreamStatus: relaycommon.NewStreamStatus()}
		c.Set("motai_relay_info", info)
		got := TerminalFromContext(c, intent)
		require.Equal(t, "succeeded", got.AttemptOutcome)
		require.Nil(t, got.ErrorDetail)
	})
	t.Run("client cancellation never carries detail", func(t *testing.T) {
		c := terminalDetailContext(502, "", "bad gateway")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		c.Request = c.Request.WithContext(ctx)
		got := TerminalFromContext(c, intent)
		require.Equal(t, "client_gone", got.AttemptOutcome)
		require.Nil(t, got.ErrorDetail)
	})
	t.Run("semantic failure on a 200 keeps detail", func(t *testing.T) {
		got := TerminalFromContext(terminalDetailContext(200, "failed", "insufficient quota"), intent)
		require.Equal(t, "upstream_failed", got.AttemptOutcome)
		require.NotNil(t, got.ErrorDetail)
	})
}

func TestTerminalErrorDetailValidatesAgainstContracts(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	if root == "" {
		t.Skip("requires MOTAI_CONTRACTS_DIR")
	}
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	require.NoError(t, err)
	fixture, err := os.ReadFile(filepath.Join(root, "fixtures", "attempt-valid.json"))
	require.NoError(t, err)
	var record Record
	require.NoError(t, common.Unmarshal(fixture, &record))
	record.Intent.StartedAt = time.Now().UTC().Add(-time.Second)
	validate := func(detail string) error {
		c := terminalDetailContext(502, "", detail)
		record.Terminal = TerminalFromContext(c, record.Intent)
		if detail != "" {
			require.NotNil(t, record.Terminal.ErrorDetail)
		}
		return validator.ValidateRecord("attempt", mustJSON(record), false)
	}
	require.NoError(t, validate(""), "terminal without error_detail (old records) stays valid")
	require.NoError(t, validate("余额不足"))
	record.Terminal = TerminalFromContext(terminalDetailContext(502, "", "x"), record.Intent)
	oversized := strings.Repeat("额", 513)
	record.Terminal.ErrorDetail = &oversized
	require.Error(t, validator.ValidateRecord("attempt", mustJSON(record), false), "513 runes are rejected")
	exact := strings.Repeat("额", 512)
	record.Terminal.ErrorDetail = &exact
	require.NoError(t, validator.ValidateRecord("attempt", mustJSON(record), false), "512 runes are accepted")
}
