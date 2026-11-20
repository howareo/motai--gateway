package internalapi

import (
	"crypto/hmac"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/attempt"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
)

func Handler(manager *configview.Manager, runtime *attempt.Runtime, token, build string, relay http.Handler) *gin.Engine {
	engine := gin.New()
	engine.Use(gin.Recovery())
	group := engine.Group("/internal/v1", func(c *gin.Context) {
		if !hmac.Equal([]byte(c.GetHeader("Authorization")), []byte("Bearer "+token)) {
			writeError(c, 401, "permission_denied")
			return
		}
		c.Next()
	})
	modelsRoutes(group, manager)
	healthRoutes(group, manager)
	probeRoutes(group, manager, runtime, relay)
	group.POST("/pools/:id/affinity-reset", func(c *gin.Context) {
		data := requestSchema(c, manager, "operation_request", 4096)
		if data == nil {
			return
		}
		var request struct {
			ID string `json:"operation_id"`
		}
		if json.Unmarshal(data, &request) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		response, err := manager.ResetAffinity(c.Request.Context(), c.Param("id"), request.ID)
		if err != nil {
			code, status := err.Error(), 409
			if code == "pool_not_found" {
				status = 404
			}
			if code != "pool_not_found" && code != "operation_conflict" {
				code, status = "activation_failed", 503
			}
			writeError(c, status, code)
			return
		}
		writeResponse(c, manager, "affinity_reset_response", response)
	})
	group.GET("/status", func(c *gin.Context) {
		value := mergeRuntimeStatus(manager.Status(c.Request.Context(), build), runtime.Status(c.Request.Context()))
		writeResponse(c, manager, "status", value)
	})
	group.GET("/events", func(c *gin.Context) {
		limit, err := strconv.Atoi(c.DefaultQuery("limit", "500"))
		after := c.DefaultQuery("after_seq", "0")
		data, _ := json.Marshal(map[string]any{"after_seq": after, "limit": limit})
		if err != nil || manager.Validator.Validate("events_query", data) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		started := time.Now()
		value, err := runtime.EventsPayload(c.Request.Context(), after, limit)
		c.Header("Server-Timing", fmt.Sprintf("events;dur=%.3f", float64(time.Since(started).Microseconds())/1000))
		if err != nil {
			writeError(c, 503, "storage_unavailable")
			return
		}
		writeResponse(c, manager, "events_page", value)
	})
	group.GET("/attempts", func(c *gin.Context) {
		q := map[string]any{"from": c.Query("from"), "to": c.Query("to"), "outcomes": []string{}, "snapshot_seq": nil, "cursor": nil, "channel_id": nil, "pool_id": nil, "model_id": nil, "kind": nil}
		for _, key := range []string{"channel_id", "pool_id", "model_id", "kind", "snapshot_seq", "cursor"} {
			if value, ok := c.GetQuery(key); ok {
				q[key] = value
			}
		}
		if value := c.Query("outcomes"); value != "" {
			q["outcomes"] = strings.Split(value, ",")
		}
		limit, err := strconv.Atoi(c.DefaultQuery("limit", "100"))
		if err != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		q["limit"] = limit
		for _, key := range []string{"stream", "reverse", "cooldown_only"} {
			if value, ok := c.GetQuery(key); ok {
				if value != "true" && value != "false" {
					writeError(c, 400, "invalid_contract")
					return
				}
				q[key] = value == "true"
			}
		}
		data, _ := json.Marshal(q)
		if manager.Validator.Validate("attempts_query", data) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		var query attempt.Query
		if json.Unmarshal(data, &query) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		started := time.Now()
		value, err := runtime.Attempts(c.Request.Context(), query)
		c.Header("Server-Timing", fmt.Sprintf("attempts;dur=%.3f", float64(time.Since(started).Microseconds())/1000))
		if err != nil {
			if err.Error() == "invalid_contract" || err.Error() == "invalid_cursor" {
				writeError(c, 400, err.Error())
			} else {
				writeError(c, 503, "storage_unavailable")
			}
			return
		}
		writeResponse(c, manager, "attempts_page", value)
	})
	group.GET("/stats", func(c *gin.Context) {
		query := map[string]any{"from": c.Query("from"), "to": c.Query("to"), "outcomes": []string{}, "snapshot_seq": nil, "channel_id": nil, "pool_id": nil, "model_id": nil, "kind": nil}
		for _, key := range []string{"channel_id", "pool_id", "model_id", "kind", "snapshot_seq"} {
			if value, ok := c.GetQuery(key); ok {
				query[key] = value
			}
		}
		if value := c.Query("outcomes"); value != "" {
			query["outcomes"] = strings.Split(value, ",")
		}
		if value, ok := c.GetQuery("stream"); ok {
			if value != "true" && value != "false" {
				writeError(c, 400, "invalid_contract")
				return
			}
			query["stream"] = value == "true"
		}
		data, _ := json.Marshal(query)
		if manager.Validator.Validate("stats_query", data) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		var q attempt.Query
		if json.Unmarshal(data, &q) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		value, err := runtime.Stats(c.Request.Context(), q)
		if err != nil {
			code, status := "gateway_log_unavailable", 503
			if err.Error() == "invalid_contract" || err.Error() == "snapshot_invalid" {
				code, status = err.Error(), 400
			}
			writeError(c, status, code)
			return
		}
		writeResponse(c, manager, "stats_response", value)
	})
	for _, operation := range []string{"drain", "resume"} {
		group.POST("/"+operation, func(c *gin.Context) {
			data, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, 4096))
			if err != nil || manager.Validator.Validate("operation_request", data) != nil {
				writeError(c, 400, "invalid_contract")
				return
			}
			var request struct {
				ID string `json:"operation_id"`
			}
			if json.Unmarshal(data, &request) != nil {
				writeError(c, 400, "invalid_contract")
				return
			}
			accepting := operation == "resume"
			runtime.SetAccepting(accepting)
			live := runtime.Status(c.Request.Context())
			writeResponse(c, manager, "drain_response", map[string]any{"format_version": 1, "operation_id": request.ID, "accepting": runtime.Accepting(), "in_flight": live["in_flight"], "completion_pending": live["completion_pending"]})
		})
	}
	group.POST("/activate", func(c *gin.Context) {
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
		data, err := io.ReadAll(c.Request.Body)
		if err != nil || manager.Validator.Validate("activate_request", data) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		var request configview.ActivateRequest
		if common.Unmarshal(data, &request) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		response, err := manager.Activate(c.Request.Context(), request)
		if err != nil {
			code, status := "activation_failed", 503
			switch err.Error() {
			case "stale_base_generation", "generation_conflict":
				code, status = err.Error(), 409
			case "invalid_config":
				code, status = err.Error(), 400
			}
			writeError(c, status, code)
			return
		}
		writeResponse(c, manager, "activate_response", response)
	})
	return engine
}

func mergeRuntimeStatus(value, live map[string]any) map[string]any {
	for _, key := range []string{"degraded_reasons", "referenced_gens"} {
		unique := []string{}
		seen := map[string]bool{}
		for _, item := range append(value[key].([]string), live[key].([]string)...) {
			if !seen[item] {
				seen[item] = true
				unique = append(unique, item)
			}
		}
		live[key] = unique
	}
	for key, item := range live {
		value[key] = item
	}
	value["ready"] = value["ready"].(bool) && len(value["degraded_reasons"].([]string)) == 0
	return value
}

func writeResponse(c *gin.Context, manager *configview.Manager, name string, value any) {
	started := time.Now()
	var data []byte
	var err error
	var pageValue any
	if page, ok := value.(interface {
		ContractValue() any
		ContractData() []byte
	}); ok && (name == "attempts_page" || name == "events_page") {
		pageValue = page.ContractValue()
		data = page.ContractData()
	} else {
		data, err = common.Marshal(value)
	}
	if name == "attempts_page" || name == "events_page" {
		c.Writer.Header().Add("Server-Timing", fmt.Sprintf("marshal;dur=%.3f", float64(time.Since(started).Microseconds())/1000))
	}
	started = time.Now()
	if err != nil {
		writeError(c, 500, "internal_error")
		return
	}
	if name == "attempts_page" || name == "events_page" {
		if pageValue != nil {
			err = manager.Validator.ValidatePageValue(name, pageValue)
		} else {
			err = manager.Validator.ValidatePage(name, data)
		}
		if err != nil {
			writeError(c, 500, "internal_error")
			return
		}
	} else if manager.Validator.Validate(name, data) != nil {
		writeError(c, 500, "internal_error")
		return
	}
	if name == "attempts_page" || name == "events_page" {
		c.Writer.Header().Add("Server-Timing", fmt.Sprintf("validate;dur=%.3f", float64(time.Since(started).Microseconds())/1000))
	}
	c.Data(200, "application/json", data)
}
func writeError(c *gin.Context, status int, code string) {
	switch code {
	case "storage_unavailable":
		code = "gateway_log_unavailable"
	case "invalid_cursor":
		code = "cursor_invalid"
	case "invalid_response":
		code = "upstream_unavailable"
	}
	c.AbortWithStatusJSON(status, gin.H{"format_version": 1, "error": gin.H{"code": code, "message": "Gateway operation failed", "retryable": status == 503,
		"details": gin.H{"gen": nil, "retry_after_seconds": nil}}})
}
