package internalapi

import (
	"time"

	"github.com/QuantumNous/new-api/controller"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
)

func accountProbe(c *gin.Context, manager *configview.Manager, kind string) {
	if requestSchema(c, manager, "models_request", 4096) == nil {
		return
	}
	channel, err := currentChannel(manager, c.Param("id"))
	if err != nil {
		writeError(c, 404, "channel_not_found")
		return
	}
	observation := controller.MotaiAccountProbe(c.Request.Context(), kind, channel.BaseURL, channel.Secret)
	writeResponse(c, manager, kind+"_probe_response", accountProbeResponse(kind, channel.ID, observation, time.Now()))
}

func accountProbeResponse(kind, id string, observation controller.MotaiAccountObservation, now time.Time) map[string]any {
	source := "unavailable"
	if observation.State == "unsupported" {
		source = "unsupported"
	}
	if observation.State == "known" {
		if kind == "billing" {
			source = "management_api"
		} else {
			source = "account_wallet"
		}
	}
	response := map[string]any{"format_version": 1, "channel_id": id, "state": observation.State, "source": source, "observed_at": now.UTC()}
	if kind == "billing" {
		response["multiplier"] = observation.Multiplier
		// Optional and local-only: an enum class and one bounded pricing group key.
		// Omitted when empty so an older console sees the previous exact shape.
		if observation.ErrorClass != "" {
			response["error_class"] = observation.ErrorClass
		}
		if observation.UpstreamGroup != "" {
			response["upstream_group"] = observation.UpstreamGroup
		}
		if observation.DailyCosts != nil {
			response["daily_costs"] = observation.DailyCosts
		}
	} else {
		response["balance"] = observation.Balance
		response["currency"] = observation.Currency
	}
	return response
}
