package middleware

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/motai/attempt"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/jsonbody"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

const MotaiSelectionKey = "motai_selection"

// The source New API Codex affinity rule passes exactly these trace/session
// headers. Keep this bounded: credentials and arbitrary client headers remain
// handled by the normal channel path and are never copied here.
var motaiCodexTraceHeaders = [...]string{
	"Originator", "Session_id", "Thread_id", "Session-Id", "Thread-Id", "X-Client-Request-Id", "User-Agent",
	"X-Codex-Beta-Features", "X-Codex-Turn-State", "X-Codex-Turn-Metadata", "X-Codex-Window-Id",
	"X-Codex-Parent-Thread-Id", "X-OpenAI-Subagent", "X-OpenAI-Memgen-Request",
	"X-ResponsesAPI-Include-Timing-Metrics", "X-OpenAI-Internal-Codex-Responses-Lite",
}

// Preserve Claude client identity independently of routing affinity; auxiliary
// CLI requests can omit metadata.user_id. No credentials or arbitrary headers.
var motaiClaudeTraceHeaders = [...]string{
	"X-Stainless-Arch", "X-Stainless-Lang", "X-Stainless-Os", "X-Stainless-Package-Version",
	"X-Stainless-Retry-Count", "X-Stainless-Runtime", "X-Stainless-Runtime-Version", "X-Stainless-Timeout",
	"User-Agent", "X-App", "Anthropic-Beta", "Anthropic-Dangerous-Direct-Browser-Access", "Anthropic-Version",
	"X-Claude-Code-Session-Id",
}

// setMotaiClientHeaderOverride makes the channel forward each named client header
// unchanged. It returns false and leaves the channel untouched on encoding failure.
func setMotaiClientHeaderOverride(channel *model.Channel, names []string) bool {
	values := make(map[string]string, len(names))
	for _, name := range names {
		values[name] = "{client_header:" + name + "}"
	}
	encoded, err := common.Marshal(values)
	if err != nil {
		return false
	}
	text := string(encoded)
	channel.HeaderOverride = &text
	return true
}

func applyMotaiCodexTraceHeaders(c *gin.Context, channel *model.Channel, modelID, protocol, promptCacheKey string, affinityEnabled bool) bool {
	if !affinityEnabled || channel == nil || c == nil || c.Request == nil || promptCacheKey == "" || protocol != "responses" {
		return false
	}
	if !(strings.HasPrefix(modelID, "gpt-") || strings.HasPrefix(modelID, "grok-")) {
		return false
	}
	path := c.Request.URL.Path
	if path != "/v1/responses" {
		return false
	}
	return setMotaiClientHeaderOverride(channel, motaiCodexTraceHeaders[:])
}

func applyMotaiClaudeTraceHeaders(c *gin.Context, channel *model.Channel, modelID, protocol string) bool {
	if channel == nil || c == nil || c.Request == nil || protocol != "messages" {
		return false
	}
	if !strings.HasPrefix(modelID, "claude-") {
		return false
	}
	if c.Request.URL.Path != "/v1/messages" {
		return false
	}
	return setMotaiClientHeaderOverride(channel, motaiClaudeTraceHeaders[:])
}

func motaiToken(c *gin.Context) string {
	token := strings.TrimPrefix(c.GetHeader("Authorization"), "Bearer ")
	if key := c.GetHeader("x-api-key"); key != "" {
		token = key
	}
	if key := c.GetHeader("x-goog-api-key"); key != "" {
		token = key
	}
	if token == "" {
		token = c.Query("key")
	}
	return token
}

func MotaiView(manager *configview.Manager, runtime *attempt.Runtime, hmacKey []byte, protocol string) gin.HandlerFunc {
	return func(c *gin.Context) {
		geminiStream := false
		if protocol == "gemini_generate_content" {
			var err error
			geminiStream, err = motaiGeminiStream(c.Param("path"), c.Query("alt"))
			if err != nil {
				motaiError(c, http.StatusBadRequest, "invalid_contract")
				return
			}
		}
		view := manager.Snapshot()
		if view == nil {
			motaiError(c, http.StatusServiceUnavailable, "gateway_not_ready")
			return
		}
		caller, err := view.Authenticate(hmacKey, motaiToken(c), c.ClientIP(), time.Now())
		probe, isProbe := c.Request.Context().Value(attempt.ProbeContextKey{}).(attempt.Probe)
		if isProbe {
			if probe.Manual {
				copyView := *view
				copyView.Config = view.Config
				copyView.Config.Channels = append([]configview.Channel(nil), view.Config.Channels...)
				for index := range copyView.Config.Channels {
					if copyView.Config.Channels[index].ID == probe.ChannelID {
						copyView.Config.Channels[index].Enabled = true
					}
				}
				view = &copyView
			}
			for _, channel := range view.Config.Channels {
				if channel.ID == probe.ChannelID {
					pool, poolErr := channel.ResolvePool(probe.PoolID)
					if poolErr != nil {
						err = poolErr
						break
					}
					caller = configview.Caller{ID: "internal-probe", Name: "Internal probe", Enabled: true, SubjectEnabled: true, Permissions: []configview.Permission{{PoolID: pool, ModelIDs: []string{probe.ModelID}, ChannelIDs: []string{probe.ChannelID}, Protocols: []string{probe.Protocol}}}}
					err = nil
					break
				}
			}
		}
		if err != nil {
			motaiError(c, http.StatusUnauthorized, "permission_denied")
			return
		}
		if err := validateMotaiJSON(c); err != nil {
			motaiError(c, http.StatusBadRequest, "invalid_contract")
			return
		}
		request, _, err := getModelRequest(c)
		if err != nil {
			motaiError(c, http.StatusBadRequest, "invalid_contract")
			return
		}
		candidates, err := view.Candidates(caller, request.Model, protocol, c.GetHeader("X-Motai-Pool"), request.Group)
		if err != nil {
			motaiError(c, http.StatusForbidden, "permission_denied")
			return
		}
		// CountClaudeTokens is a local estimator: permissions still apply, but it
		// neither dispatches nor creates a generation attempt or health result.
		if protocol == "count_tokens" {
			c.Next()
			return
		}
		meta, err := readMotaiMetadata(c, protocol, geminiStream)
		if err != nil {
			motaiError(c, 400, "invalid_contract")
			return
		}
		session := c.GetHeader("X-Motai-Session")
		if session == "" {
			session = c.GetHeader("Session_id")
		}
		if session == "" {
			session = meta.PromptCacheKey
		}
		if session == "" {
			session = meta.UserID
		}
		if len(session) > 4096 {
			motaiError(c, 400, "invalid_contract")
			return
		}
		base := candidates[0]
		intent := attempt.Intent{FormatVersion: 1, Source: "motai", RequestID: uuid.NewString(), AttemptID: uuid.NewString(), Kind: "model", Gen: view.Config.Gen, PoolEpoch: base.Epoch, CallerID: caller.ID, PoolID: base.Pool, ModelRequested: request.Model, ModelCanonical: base.Model, Protocol: protocol, Stream: meta.Stream, StartedAt: time.Now().UTC(), ThinkingBudget: meta.ThinkingBudget, AttemptNo: 1}
		intent.Effort.Value = meta.Effort
		if meta.Effort != nil {
			value := "request"
			intent.Effort.Source = &value
		}
		intent.Affinity = runtime.Scope(caller.ID, base.Pool, base.Model, protocol, base.Epoch, session)
		if isProbe {
			intent.Kind = "probe"
			intent.RequestID = probe.RequestID
			intent.AttemptID = probe.AttemptID
		}
		admitCtx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Second)
		explicit := c.GetHeader("X-Motai-Channel")
		if isProbe {
			explicit = probe.ChannelID
		}
		c.Header("X-Motai-Request-Id", intent.RequestID)
		selected, intent, err := runtime.Admit(admitCtx, candidates, intent, explicit)
		cancel()
		if err != nil {
			status, code, retryAfter := motaiAdmissionError(err, time.Now())
			if retryAfter != "" {
				c.Header("Retry-After", retryAfter)
			}
			log.Printf("motai admission_rejected code=%q request_id=%q pool=%q model=%q protocol=%q retry_after=%q", code, intent.RequestID, intent.PoolID, intent.ModelCanonical, intent.Protocol, retryAfter)
			motaiError(c, status, code)
			return
		}
		c.Header("X-Motai-Attempt-Id", intent.AttemptID)
		defer func() {
			runtime.Complete(intent, attempt.TerminalFromContext(c, intent), view.Config.Affinity.TTLSeconds)
		}()
		c.Set(MotaiSelectionKey, selected)
		c.Set("motai_retry_after_max_seconds", selected.View.Config.FailurePolicy.RetryAfterMaxSeconds)
		c.Set("specific_channel_id", selected.Channel.ID)
		c.Set("id", 1)
		c.Set("token_id", 1)
		c.Set("token_unlimited_quota", true)
		c.Set("token_name", caller.Name)
		c.Set("group", selected.Pool)
		c.Set("using_group", selected.Pool)
		c.Set("token_group", selected.Pool)
		common.SetContextKey(c, constant.ContextKeyRequestStartTime, time.Now())
		kind, err := motaiChannelType(selected.Channel.Adapter, protocol)
		if err != nil {
			motaiError(c, http.StatusBadRequest, "invalid_contract")
			return
		}
		mapping, _ := common.Marshal(map[string]string{selected.Model: selected.UpstreamModel})
		mappingText := string(mapping)
		zero := 0
		channel := &model.Channel{Id: 1, Type: kind, Name: selected.Channel.Name, Key: selected.Channel.Secret,
			BaseURL: &selected.Channel.BaseURL, ModelMapping: &mappingText, AutoBan: &zero, Status: common.ChannelStatusEnabled}
		// Codex trace follows its affinity rule; Claude identity is transport metadata.
		if !applyMotaiCodexTraceHeaders(c, channel, request.Model, protocol, meta.PromptCacheKey, view.Config.Affinity.Enabled) {
			applyMotaiClaudeTraceHeaders(c, channel, request.Model, protocol)
		}
		if apiErr := SetupContextForSelectedChannel(c, channel, selected.Model); apiErr != nil {
			motaiError(c, 500, "internal_error")
			return
		}
		c.Next()
	}
}

func validateMotaiJSON(c *gin.Context) error {
	storage, err := common.GetBodyStorage(c)
	if err != nil {
		return err
	}
	if _, err := storage.Seek(0, io.SeekStart); err != nil {
		return err
	}
	validationErr := jsonbody.Validate(storage)
	if _, err := storage.Seek(0, io.SeekStart); err != nil {
		return err
	}
	c.Request.Body = io.NopCloser(storage)
	return validationErr
}

// Explicit adapters preserve source transport semantics independently of pool,
// model vendor and incoming protocol. Omission keeps pre-adapter configs working.
func motaiChannelType(adapter, protocol string) (int, error) {
	switch adapter {
	case "openai":
		return constant.ChannelTypeOpenAI, nil
	case "anthropic":
		return constant.ChannelTypeAnthropic, nil
	case "deepseek":
		return constant.ChannelTypeDeepSeek, nil
	case "xai":
		return constant.ChannelTypeXai, nil
	case "gemini":
		return constant.ChannelTypeGemini, nil
	case "moonshot":
		return constant.ChannelTypeMoonshot, nil
	case "":
		switch protocol {
		case "messages", "count_tokens":
			return constant.ChannelTypeAnthropic, nil
		case "gemini_generate_content":
			return constant.ChannelTypeGemini, nil
		default:
			return constant.ChannelTypeOpenAI, nil
		}
	default:
		return 0, errors.New("invalid_contract")
	}
}

func motaiGeminiStream(path, alt string) (bool, error) {
	model, action, found := strings.Cut(strings.TrimPrefix(path, "/"), ":")
	if !found || model == "" || (action != "generateContent" && action != "streamGenerateContent") {
		return false, errors.New("invalid_contract")
	}
	return action == "streamGenerateContent" || alt == "sse", nil
}

type motaiMetadata struct {
	Stream                 bool
	PromptCacheKey, UserID string
	Effort                 *string
	ThinkingBudget         *int64
}

func readMotaiMetadata(c *gin.Context, protocol string, geminiStream bool) (motaiMetadata, error) {
	var wire struct {
		Stream          bool    `json:"stream"`
		PromptCacheKey  string  `json:"prompt_cache_key"`
		ReasoningEffort *string `json:"reasoning_effort"`
		Metadata        struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
		Reasoning struct {
			Effort *string `json:"effort"`
		} `json:"reasoning"`
		Thinking struct {
			Budget *int64 `json:"budget_tokens"`
		} `json:"thinking"`
		OutputConfig struct {
			Effort *string `json:"effort"`
		} `json:"output_config"`
		GenerationConfig dto.GeminiChatGenerationConfig `json:"generationConfig"`
	}
	if err := common.UnmarshalBodyReusable(c, &wire); err != nil {
		return motaiMetadata{}, err
	}
	meta := motaiMetadata{Stream: wire.Stream, PromptCacheKey: wire.PromptCacheKey, UserID: wire.Metadata.UserID,
		Effort: wire.Reasoning.Effort, ThinkingBudget: wire.Thinking.Budget}
	switch protocol {
	case "chat_completions":
		if wire.ReasoningEffort != nil {
			meta.Effort = wire.ReasoningEffort
		}
	case "messages":
		meta.Effort = wire.OutputConfig.Effort
	case "gemini_generate_content":
		meta.Effort, meta.ThinkingBudget, meta.Stream = nil, nil, geminiStream
		if thinking := wire.GenerationConfig.ThinkingConfig; thinking != nil {
			if thinking.ThinkingLevel != "" {
				meta.Effort = &thinking.ThinkingLevel
			}
			if thinking.ThinkingBudget != nil {
				value := int64(*thinking.ThinkingBudget)
				meta.ThinkingBudget = &value
			}
		}
	}
	if meta.ThinkingBudget != nil && *meta.ThinkingBudget < 0 && (protocol != "gemini_generate_content" || *meta.ThinkingBudget != -1) {
		return motaiMetadata{}, errors.New("invalid_contract")
	}
	return meta, nil
}

func motaiAdmissionError(err error, now time.Time) (int, string, string) {
	var unavailable *attempt.ChannelUnavailableError
	switch {
	case errors.Is(err, attempt.ErrInvalidIntent):
		return http.StatusBadRequest, "invalid_contract", ""
	case errors.Is(err, attempt.ErrDraining):
		return http.StatusServiceUnavailable, "gateway_draining", "1"
	case errors.Is(err, attempt.ErrBusy):
		return http.StatusServiceUnavailable, "gateway_busy", "1"
	case errors.As(err, &unavailable) || err.Error() == "channel_temporarily_unavailable":
		retryAfter := ""
		if unavailable != nil && !unavailable.RetryAt.IsZero() {
			seconds := max(int64(1), int64((unavailable.RetryAt.Sub(now)+time.Second-1)/time.Second))
			retryAfter = strconv.FormatInt(seconds, 10)
		}
		return http.StatusServiceUnavailable, "channel_temporarily_unavailable", retryAfter
	default:
		return http.StatusServiceUnavailable, "gateway_log_unavailable", ""
	}
}

func motaiError(c *gin.Context, status int, code string) {
	message := "Gateway request rejected"
	if code == "channel_temporarily_unavailable" {
		message = "No eligible channel is currently available"
	}
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": message}})
}
