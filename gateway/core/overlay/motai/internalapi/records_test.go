package internalapi

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestStatusPreservesAllRuntimeDegradationReasons(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	require.NotEmpty(t, root)
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	require.NoError(t, err)
	data, err := os.ReadFile(filepath.Join(root, "fixtures", "internal-api-samples.json"))
	require.NoError(t, err)
	var fixtures struct {
		Samples map[string]map[string]any `json:"samples"`
	}
	require.NoError(t, json.Unmarshal(data, &fixtures))
	value := fixtures.Samples["status"]
	value["degraded_reasons"] = []string{"storage_unavailable"}
	value["referenced_gens"] = []string{"1"}
	reasons := []string{"not_activated", "configuration_invalid", "storage_unavailable", "completion_queue_full", "completion_write_failed", "completion_lag", "completion_wait_exceeded", "runtime_lease_lost", "in_flight_limit", "draining"}
	value = mergeRuntimeStatus(value, map[string]any{"degraded_reasons": reasons, "referenced_gens": []string{"1", "2"}})
	require.False(t, value["ready"].(bool))
	require.ElementsMatch(t, reasons, value["degraded_reasons"])
	require.Equal(t, []string{"1", "2"}, value["referenced_gens"])
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	writeResponse(c, &configview.Manager{Validator: validator}, "status", value)
	require.Equal(t, 200, recorder.Code, recorder.Body.String())
}

func TestRecordPagesRejectInvalidSuccessSemantics(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	require.NotEmpty(t, root)
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	require.NoError(t, err)
	data, err := os.ReadFile(filepath.Join(root, "fixtures", "internal-api-samples.json"))
	require.NoError(t, err)
	var fixtures struct {
		Samples map[string]any `json:"samples"`
	}
	require.NoError(t, common.Unmarshal(data, &fixtures))
	for _, name := range []string{"attempts_page", "events_page"} {
		t.Run(name, func(t *testing.T) {
			value := fixtures.Samples[name].(map[string]any)
			manager := &configview.Manager{Validator: validator}
			recorder := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(recorder)
			writeResponse(c, manager, name, value)
			require.Equal(t, 200, recorder.Code)
			require.Regexp(t, `marshal;dur=[0-9.]+`, recorder.Header().Get("Server-Timing"))
			require.Regexp(t, `validate;dur=[0-9.]+`, recorder.Header().Values("Server-Timing")[1])
			var record map[string]any
			if name == "attempts_page" {
				record = value["attempts"].([]any)[0].(map[string]any)
			} else {
				record = value["events"].([]any)[0].(map[string]any)["attempt"].(map[string]any)
			}
			record["terminal"].(map[string]any)["upstream_status"] = nil
			recorder = httptest.NewRecorder()
			c, _ = gin.CreateTestContext(recorder)
			writeResponse(c, manager, name, value)
			require.Equal(t, 500, recorder.Code)
			require.Contains(t, recorder.Body.String(), "internal_error")
			require.NotContains(t, recorder.Body.String(), "attempts")
		})
	}
}
