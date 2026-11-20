package internalapi

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func TestModelPreviewUsesExplicitAdapterCatalogAuthentication(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	if root == "" {
		t.Fatal("MOTAI_CONTRACTS_DIR required")
	}
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	if err != nil {
		t.Fatal(err)
	}
	service.InitHttpClient()
	for _, fixture := range []struct {
		adapter, capability, path, auth, apiKey, version, googleKey string
	}{
		{"", "messages", "/prefix/v1/models", "Bearer SECRET", "", "", ""},
		{"openai", "messages", "/prefix/v1/models", "Bearer SECRET", "", "", ""},
		{"anthropic", "chat_completions", "/prefix/v1/models", "", "SECRET", "2023-06-01", ""},
		{"deepseek", "messages", "/prefix/v1/models", "Bearer SECRET", "", "", ""},
		{"xai", "responses", "/prefix/v1/models", "Bearer SECRET", "", "", ""},
		{"gemini", "gemini_generate_content", "/prefix/v1beta/models", "", "", "", "SECRET"},
	} {
		t.Run("adapter="+fixture.adapter, func(t *testing.T) {
			calls := 0
			upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				calls++
				if request.Method != http.MethodGet || request.URL.Path != fixture.path || request.URL.RawQuery != "" ||
					request.Header.Get("Authorization") != fixture.auth || request.Header.Get("x-api-key") != fixture.apiKey ||
					request.Header.Get("anthropic-version") != fixture.version || request.Header.Get("x-goog-api-key") != fixture.googleKey {
					t.Error("catalog request did not use the configured adapter's path and credentials")
				}
				writer.Header().Set("Content-Type", "application/json")
				if fixture.adapter == "gemini" {
					io.WriteString(writer, `{"models":[{"name":"models/Visible","supportedGenerationMethods":["generateContent"]}]}`)
				} else {
					io.WriteString(writer, `{"data":[{"id":"Visible"}]}`)
				}
			}))
			defer upstream.Close()
			body := map[string]any{"format_version": 1, "base_url": upstream.URL + "/prefix", "credential": "SECRET", "channel_id": nil, "capabilities": []string{fixture.capability}}
			if fixture.adapter != "" {
				body["adapter"] = fixture.adapter
			}
			data, err := common.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			engine := gin.New()
			modelsRoutes(engine.Group("/internal/v1"), &configview.Manager{Validator: validator})
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/v1/models/preview", bytes.NewReader(data)))
			if response.Code != http.StatusOK || calls != 1 || !strings.Contains(response.Body.String(), `"id":"Visible"`) || strings.Contains(response.Body.String(), "SECRET") {
				t.Fatalf("preview status=%d calls=%d response=%s", response.Code, calls, response.Body.String())
			}
		})
	}
}

func TestModelPreviewRejectsInvalidOrIncompatibleAdaptersBeforeDispatch(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	if root == "" {
		t.Fatal("MOTAI_CONTRACTS_DIR required")
	}
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	if err != nil {
		t.Fatal(err)
	}
	service.InitHttpClient()
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		io.WriteString(writer, `{"data":[]}`)
	}))
	defer upstream.Close()
	for _, fixture := range []struct {
		name       string
		adapter    any
		capability []string
		status     int
	}{
		{"unknown", "unknown", []string{"responses"}, 400},
		{"empty", "", []string{"responses"}, 400},
		{"null", nil, []string{"responses"}, 400},
		{"openai cannot claim native Gemini", "openai", []string{"gemini_generate_content"}, 422},
		{"Gemini cannot claim Responses", "gemini", []string{"responses"}, 422},
		{"Gemini mixed protocols", "gemini", []string{"gemini_generate_content", "messages"}, 422},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			data, err := common.Marshal(map[string]any{"format_version": 1, "base_url": upstream.URL, "credential": "SECRET", "channel_id": nil, "capabilities": fixture.capability, "adapter": fixture.adapter})
			if err != nil {
				t.Fatal(err)
			}
			engine := gin.New()
			modelsRoutes(engine.Group("/internal/v1"), &configview.Manager{Validator: validator})
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/internal/v1/models/preview", bytes.NewReader(data)))
			if response.Code != fixture.status || calls != 0 || strings.Contains(response.Body.String(), "SECRET") {
				t.Fatalf("invalid adapter status=%d calls=%d response=%s", response.Code, calls, response.Body.String())
			}
		})
	}
}
