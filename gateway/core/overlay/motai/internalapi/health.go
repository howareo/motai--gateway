package internalapi

import (
	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
)

func healthRoutes(group *gin.RouterGroup, manager *configview.Manager) {
	group.GET("/channels/health", func(c *gin.Context) {
		value, err := manager.ChannelHealth(c.Request.Context())
		if err != nil {
			writeError(c, 503, "gateway_log_unavailable")
			return
		}
		writeResponse(c, manager, "channel_health_response", value)
	})
	group.POST("/channels/:id/health-reset", func(c *gin.Context) {
		data := requestSchema(c, manager, "health_reset_request", 4096)
		if data == nil {
			return
		}
		var request configview.HealthResetRequest
		if common.Unmarshal(data, &request) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		response, err := manager.ResetChannelHealth(c.Request.Context(), c.Param("id"), request)
		if err != nil {
			code, status := err.Error(), 409
			if code == "channel_not_found" {
				status = 404
			} else if code == "invalid_contract" {
				status = 400
			} else if code != "operation_conflict" && code != "channel_state_conflict" && code != "stale_base_generation" {
				code, status = "gateway_log_unavailable", 503
			}
			writeError(c, status, code)
			return
		}
		writeResponse(c, manager, "health_reset_response", response)
	})
}
