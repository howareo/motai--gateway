package internalapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func modelsRoutes(group *gin.RouterGroup, manager *configview.Manager) {
	fetchModels := func(c *gin.Context, base, secret, adapter string, capabilities []string) {
		switch adapter {
		case "", "openai", "anthropic", "deepseek", "xai", "gemini":
		default:
			writeError(c, 400, "invalid_contract")
			return
		}
		hasGemini := false
		for _, capability := range capabilities {
			hasGemini = hasGemini || capability == "gemini_generate_content"
		}
		if (hasGemini && (len(capabilities) != 1 || (adapter != "" && adapter != "gemini"))) || (adapter == "gemini" && !hasGemini) {
			// Discovery does not prove that an OpenAI catalog also supports Gemini.
			writeError(c, 422, "unsupported_model")
			return
		}
		u, err := url.Parse(base)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" || strings.EqualFold(u.Host, c.Request.Host) {
			writeError(c, 400, "invalid_contract")
			return
		}
		for _, target := range manager.Forbidden {
			other, err := url.Parse(target)
			if err == nil && strings.EqualFold(other.Host, u.Host) {
				writeError(c, 400, "invalid_contract")
				return
			}
		}
		ctx, cancel := context.WithTimeout(c.Request.Context(), 10*time.Second)
		defer cancel()
		// Both saved channels and previews are operator-managed targets. Keep
		// the configured relay policy, including legitimate private HTTP hosts.
		shared := service.GetHttpClient()
		if shared == nil {
			writeError(c, 503, "upstream_unavailable")
			return
		}
		copyClient := *shared
		copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
		client := &copyClient
		if hasGemini {
			models, err := discoverGeminiModels(ctx, client, u, secret)
			if err != nil {
				writeError(c, 502, err.Error())
				return
			}
			writeResponse(c, manager, "models_response", map[string]any{"format_version": 1, "models": models, "observed_at": time.Now().UTC()})
			return
		}
		u.Path = modelsPath(u.Path)
		u.RawPath = ""
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		if adapter == "anthropic" {
			request.Header.Set("anthropic-version", "2023-06-01")
			if secret != "" {
				request.Header.Set("x-api-key", secret)
			}
		} else if secret != "" {
			request.Header.Set("Authorization", "Bearer "+secret)
		}
		response, err := client.Do(request)
		if err != nil {
			writeError(c, 502, "upstream_unavailable")
			return
		}
		defer response.Body.Close()
		data, err := io.ReadAll(io.LimitReader(response.Body, 1<<20+1))
		if err != nil || len(data) > 1<<20 || response.StatusCode != 200 {
			writeError(c, 502, "upstream_unavailable")
			return
		}
		var payload struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if json.Unmarshal(data, &payload) != nil {
			writeError(c, 502, "invalid_response")
			return
		}
		models := []map[string]any{}
		seen := map[string]bool{}
		for _, row := range payload.Data {
			if row.ID == "" || seen[row.ID] {
				continue
			}
			seen[row.ID] = true
			models = append(models, map[string]any{"id": row.ID, "capabilities": capabilities})
			if len(models) > 10000 {
				writeError(c, 502, "invalid_response")
				return
			}
		}
		writeResponse(c, manager, "models_response", map[string]any{"format_version": 1, "models": models, "observed_at": time.Now().UTC()})
	}
	group.POST("/channels/:id/models", func(c *gin.Context) {
		if requestSchema(c, manager, "models_request", 4096) == nil {
			return
		}
		channel, err := currentChannel(manager, c.Param("id"))
		if err != nil {
			writeError(c, 404, "channel_not_found")
			return
		}
		capabilities := []string{}
		seen := map[string]bool{}
		for _, model := range channel.Models {
			for _, protocol := range model.Capabilities {
				if !seen[protocol] {
					seen[protocol] = true
					capabilities = append(capabilities, protocol)
				}
			}
		}
		fetchModels(c, channel.BaseURL, channel.Secret, channel.Adapter, capabilities)
	})
	group.POST("/models/preview", func(c *gin.Context) {
		data := requestSchema(c, manager, "preview_request", 65536)
		if data == nil {
			return
		}
		var request struct {
			BaseURL      string   `json:"base_url"`
			Credential   *string  `json:"credential"`
			ChannelID    *string  `json:"channel_id"`
			Adapter      *string  `json:"adapter"`
			Capabilities []string `json:"capabilities"`
		}
		if json.Unmarshal(data, &request) != nil {
			writeError(c, 400, "invalid_contract")
			return
		}
		secret, adapter := "", ""
		if request.Credential != nil {
			secret = *request.Credential
		}
		if request.Adapter != nil {
			adapter = *request.Adapter
		}
		if request.ChannelID != nil && (request.Credential == nil || request.Adapter == nil) {
			channel, err := currentChannel(manager, *request.ChannelID)
			if err != nil {
				writeError(c, 404, "channel_not_found")
				return
			}
			if request.Credential == nil {
				secret = channel.Secret
			}
			if request.Adapter == nil {
				adapter = channel.Adapter
			}
		}
		fetchModels(c, request.BaseURL, secret, adapter, request.Capabilities)
	})
	for _, kind := range []string{"billing", "wallet"} {
		group.POST("/channels/:id/"+kind+"-probe", func(c *gin.Context) {
			accountProbe(c, manager, kind)
		})
	}
}

// The upstream Gemini adaptor's list helper only returns names and silently
// stops at its page limit. Keep its native wire fields, but require a complete,
// bounded catalog and evidence of generateContent before advertising capability.
func discoverGeminiModels(ctx context.Context, client *http.Client, base *url.URL, secret string) ([]map[string]any, error) {
	const maxPageBytes = 1 << 20
	const maxTotalBytes = 4 << 20
	const maxPages = 20
	u := *base
	u.Path = geminiModelsPath(u.Path)
	u.RawPath = ""
	models := []map[string]any{}
	seenModels, seenTokens := map[string]bool{}, map[string]bool{}
	token, totalBytes, totalModels := "", 0, 0
	// The caller owns the overall deadline; no page gets a fresh timeout.
	for page := 0; page < maxPages; page++ {
		query := url.Values{}
		if token != "" {
			query.Set("pageToken", token)
		}
		u.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return nil, errors.New("invalid_response")
		}
		request.Header.Set("x-goog-api-key", secret)
		response, err := client.Do(request)
		if err != nil {
			return nil, errors.New("upstream_unavailable")
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, maxPageBytes+1))
		response.Body.Close()
		if readErr != nil || response.StatusCode != http.StatusOK {
			return nil, errors.New("upstream_unavailable")
		}
		totalBytes += len(data)
		if len(data) > maxPageBytes || totalBytes > maxTotalBytes {
			return nil, errors.New("invalid_response")
		}
		var payload struct {
			Models []struct {
				Name    string   `json:"name"`
				Methods []string `json:"supportedGenerationMethods"`
			} `json:"models"`
			NextPageToken json.RawMessage `json:"nextPageToken"`
		}
		if json.Unmarshal(data, &payload) != nil || payload.Models == nil {
			return nil, errors.New("invalid_response")
		}
		totalModels += len(payload.Models)
		if totalModels > 10000 {
			return nil, errors.New("invalid_response")
		}
		for _, row := range payload.Models {
			generate := false
			for _, method := range row.Methods {
				generate = generate || method == "generateContent"
			}
			if !generate {
				continue
			}
			id := strings.TrimPrefix(row.Name, "models/")
			if id == "" || !utf8.ValidString(id) || utf8.RuneCountInString(id) > 256 || strings.IndexFunc(id, func(r rune) bool { return unicode.IsSpace(r) || r < 0x20 || r == 0x7f }) >= 0 {
				return nil, errors.New("invalid_response")
			}
			if !seenModels[id] {
				seenModels[id] = true
				models = append(models, map[string]any{"id": id, "capabilities": []string{"gemini_generate_content"}})
			}
		}
		token = ""
		if payload.NextPageToken != nil {
			if string(payload.NextPageToken) == "null" || json.Unmarshal(payload.NextPageToken, &token) != nil {
				return nil, errors.New("invalid_response")
			}
		}
		if token == "" {
			return models, nil
		}
		if len(token) > 4096 || strings.TrimSpace(token) != token || seenTokens[token] {
			return nil, errors.New("invalid_response")
		}
		seenTokens[token] = true
	}
	return nil, errors.New("invalid_response")
}

func geminiModelsPath(path string) string {
	path = strings.TrimRight(path, "/")
	if strings.HasSuffix(path, "/v1beta") {
		return path + "/models"
	}
	return path + "/v1beta/models"
}

func modelsPath(path string) string {
	path = strings.TrimRight(path, "/")
	if strings.HasSuffix(path, "/v1") {
		return path + "/models"
	}
	return path + "/v1/models"
}
func currentChannel(manager *configview.Manager, id string) (configview.Channel, error) {
	view := manager.Snapshot()
	if view != nil {
		for _, channel := range view.Config.Channels {
			if channel.ID == id {
				return channel, nil
			}
		}
	}
	return configview.Channel{}, errors.New("channel_not_found")
}
func requestSchema(c *gin.Context, manager *configview.Manager, name string, limit int64) []byte {
	data, err := io.ReadAll(http.MaxBytesReader(c.Writer, c.Request.Body, limit))
	if err != nil || manager.Validator.Validate(name, data) != nil {
		writeError(c, 400, "invalid_contract")
		return nil
	}
	return data
}
