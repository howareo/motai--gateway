package service

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestMotaiHealthObservationRequiresUpstreamAndDoesNotRetainText(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set("motai_retry_after_max_seconds", 60)
	failure := types.WithOpenAIError(types.OpenAIError{Code: "invalid_api_key", Message: "CANARY_SECRET_PROVIDER_ERROR"}, 401)
	ObserveMotaiTerminal(c, nil, failure)
	require.Empty(t, c.GetString("motai_health_error_class"))
	ObserveMotaiHTTP(c, &http.Response{StatusCode: 401})
	ObserveMotaiTerminal(c, nil, failure)
	require.Equal(t, "auth_invalid", c.GetString("motai_health_error_class"))
	// Rule change: the sanitized upstream message is now deliberately kept under "motai_error_detail" only.
	// Every other key must still be free of provider text.
	for key, value := range c.Keys {
		if key == "motai_error_detail" {
			require.Equal(t, "CANARY_SECRET_PROVIDER_ERROR", value)
			continue
		}
		require.NotContains(t, fmt.Sprint(value), "CANARY_SECRET_PROVIDER_ERROR")
	}
	c, _ = gin.CreateTestContext(httptest.NewRecorder())
	c.Set("motai_retry_after_max_seconds", 60)
	ObserveMotaiHTTP(c, &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"120"}}})
	value, ok := c.Get("motai_retry_after_until")
	require.True(t, ok)
	require.WithinDuration(t, time.Now().Add(time.Minute), value.(time.Time), time.Second)
	c, _ = gin.CreateTestContext(httptest.NewRecorder())
	c.Set("motai_retry_after_max_seconds", 60)
	ObserveMotaiHTTP(c, &http.Response{StatusCode: 403, Header: http.Header{"Retry-After": []string{"120"}}})
	_, ok = c.Get("motai_retry_after_until")
	require.False(t, ok)
}

func TestMotaiHealthSemanticFailureUsesProviderClassification(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Set("motai_upstream_status", 200)
	ObserveMotaiResponses(c, "response.failed", &dto.OpenAIResponsesResponse{Error: types.OpenAIError{Code: "insufficient_quota", Message: "CANARY_SECRET_SEMANTIC"}})
	require.Equal(t, "failed", c.GetString("motai_protocol_terminal"))
	require.Equal(t, "funds_exhausted", c.GetString("motai_health_error_class"))
	for _, value := range c.Keys {
		require.NotContains(t, fmt.Sprint(value), "CANARY_SECRET_SEMANTIC")
	}
}
