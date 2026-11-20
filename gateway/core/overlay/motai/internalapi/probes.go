package internalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"time"

	"github.com/QuantumNous/new-api/motai/attempt"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

func probeRoutes(group *gin.RouterGroup, manager *configview.Manager, runtime *attempt.Runtime, relay http.Handler) {
	group.POST("/probes", func(c *gin.Context) {
		data := requestSchema(c, manager, "probe_request", 8192)
		if data == nil {
			return
		}
		var request struct {
			Source    string `json:"source"`
			ChannelID string `json:"channel_id"`
			PoolID    string `json:"pool_id"`
			ModelID   string `json:"model_id"`
			Protocol  string `json:"protocol"`
			RunID     string `json:"client_run_id"`
		}
		if json.Unmarshal(data, &request) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		if request.Protocol == "count_tokens" {
			writeError(c, 400, "invalid_contract")
			return
		}
		channel, err := currentChannel(manager, request.ChannelID)
		if err != nil {
			writeError(c, 404, "channel_not_found")
			return
		}
		pool, err := channel.ResolvePool(request.PoolID)
		if err != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		found := false
		for _, model := range channel.Models {
			if model.ModelID == request.ModelID {
				for _, protocol := range model.Capabilities {
					if protocol == request.Protocol {
						found = true
					}
				}
			}
		}
		if !found {
			writeError(c, 400, "invalid_contract")
			return
		}
		state := "accepted"
		var requestID, attemptID *string
		if request.Source == "scheduled" && !channel.Enabled {
			state = "skipped_disabled"
		} else {
			a, b := uuid.NewString(), uuid.NewString()
			requestID, attemptID = &a, &b
		}
		response := map[string]any{"format_version": 1, "client_run_id": request.RunID, "request_id": requestID, "attempt_id": attemptID, "state": state}
		response, start, err := runtime.ClaimProbe(c.Request.Context(), request.RunID, data, response)
		if err != nil {
			if err.Error() == "operation_conflict" {
				writeError(c, 409, "operation_conflict")
			} else {
				writeError(c, 503, "probe_unavailable")
			}
			return
		}
		if start && state == "accepted" {
			probe := attempt.Probe{ChannelID: request.ChannelID, PoolID: pool, ModelID: request.ModelID, Protocol: request.Protocol, RequestID: *requestID, AttemptID: *attemptID, Manual: request.Source == "manual"}
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				ctx = context.WithValue(ctx, attempt.ProbeContextKey{}, probe)
				path, body := probeRequest(probe.Protocol, probe.ModelID, probe.RequestID)
				raw, _ := json.Marshal(body)
				req, _ := http.NewRequestWithContext(ctx, http.MethodPost, path, bytes.NewReader(raw))
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Motai-Pool", probe.PoolID)
				applyProbeRequestHeaders(req, probe.Protocol, probe.ModelID, probe.RequestID)
				relay.ServeHTTP(httptest.NewRecorder(), req)
				finish, cancelFinish := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancelFinish()
				runtime.FinishProbe(finish, request.RunID)
			}()
		}
		writeResponse(c, manager, "probe_response", response)
	})
}
