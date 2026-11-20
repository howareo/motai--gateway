package internalapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/service"
	"github.com/gin-gonic/gin"
)

func TestModelsPathPreservesPrefix(t *testing.T) {
	for _, test := range []struct{ base, want string }{{"/", "/v1/models"}, {"/v1", "/v1/models"}, {"/prefix", "/prefix/v1/models"}, {"/prefix/v1", "/prefix/v1/models"}, {"/prefix/v1/", "/prefix/v1/models"}} {
		if got := modelsPath(test.base); got != test.want {
			t.Fatalf("modelsPath(%q)=%q want %q", test.base, got, test.want)
		}
	}
}

type modelTransport func(*http.Request) (*http.Response, error)

func (fn modelTransport) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }
func modelResponse(body string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func TestGeminiModelsPathAndNativePaginatedWhitelist(t *testing.T) {
	for _, fixture := range []struct{ base, want string }{
		{"/", "/v1beta/models"}, {"/prefix", "/prefix/v1beta/models"},
		{"/prefix/v1beta/", "/prefix/v1beta/models"},
	} {
		if got := geminiModelsPath(fixture.base); got != fixture.want {
			t.Fatalf("path %q != %q", got, fixture.want)
		}
	}
	base, _ := url.Parse("https://upstream.example/prefix/v1beta")
	calls := 0
	client := &http.Client{Transport: modelTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.Method != "GET" || request.URL.Path != "/prefix/v1beta/models" || request.Header.Get("x-goog-api-key") != "SECRET" || request.Header.Get("Authorization") != "" || request.URL.Query().Get("key") != "" {
			t.Fatalf("wrong native request: %s %s", request.Method, request.URL)
		}
		if calls == 1 {
			return modelResponse(`{"models":[{"name":"models/Gemini/Case","supportedGenerationMethods":["generateContent","countTokens","predict"]},{"name":"models/embed","supportedGenerationMethods":["embedContent"]},{"name":"models/unknown"}],"nextPageToken":"a+b /?="}`), nil
		}
		if calls != 2 || request.URL.Query().Get("pageToken") != "a+b /?=" {
			t.Fatal("page token not encoded and round-tripped")
		}
		return modelResponse(`{"models":[{"name":"models/Gemini/Case","supportedGenerationMethods":["generateContent"]},{"name":"models/models/Once","supportedGenerationMethods":["generateContent"]}]}`), nil
	})}
	rows, err := discoverGeminiModels(context.Background(), client, base, "SECRET")
	want := []map[string]any{{"id": "Gemini/Case", "capabilities": []string{"gemini_generate_content"}}, {"id": "models/Once", "capabilities": []string{"gemini_generate_content"}}}
	if err != nil || !reflect.DeepEqual(rows, want) || calls != 2 {
		t.Fatalf("rows=%v calls=%d err=%v", rows, calls, err)
	}
	if base.RawQuery != "" || base.Path != "/prefix/v1beta" {
		t.Fatal("mutated configured URL")
	}
}

func TestGeminiModelsRejectIncompleteOrUnboundedCatalog(t *testing.T) {
	base, _ := url.Parse("https://upstream.example")
	validRow := `{"name":"models/a","supportedGenerationMethods":["generateContent"]}`
	for _, fixture := range []struct {
		name, body string
		wantCalls  int
	}{
		{"missing models", `{}`, 1}, {"null models", `{"models":null}`, 1},
		{"malformed", `{"models":`, 1}, {"wrong token type", `{"models":[],"nextPageToken":7}`, 1},
		{"null token", `{"models":[],"nextPageToken":null}`, 1},
		{"oversized token", `{"models":[],"nextPageToken":"` + strings.Repeat("a", 4097) + `"}`, 1},
		{"blank token", `{"models":[],"nextPageToken":" "}`, 1},
		{"repeated token", `{"models":[],"nextPageToken":"same"}`, 2},
		{"page bytes", `{"models":[],"padding":"` + strings.Repeat("a", 1<<20) + `"}`, 1},
		{"raw model count", `{"models":[` + strings.Repeat(validRow+",", 10000) + validRow + `]}`, 1},
		{"bad ID", `{"models":[{"name":"models/a b","supportedGenerationMethods":["generateContent"]}]}`, 1},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: modelTransport(func(*http.Request) (*http.Response, error) { calls++; return modelResponse(fixture.body), nil })}
			rows, err := discoverGeminiModels(context.Background(), client, base, "SECRET")
			if err == nil || rows != nil || calls != fixture.wantCalls {
				t.Fatalf("accepted incomplete catalog: rows=%v err=%v calls=%d", rows, err, calls)
			}
			if strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), fixture.body) {
				t.Fatal("leaked upstream detail")
			}
		})
	}
	for _, mode := range []string{"pages", "total bytes"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: modelTransport(func(*http.Request) (*http.Response, error) {
				calls++
				padding := ""
				if mode == "total bytes" {
					padding = strings.Repeat("x", 900000)
				}
				return modelResponse(fmt.Sprintf(`{"models":[],"nextPageToken":"page%d","padding":"%s"}`, calls, padding)), nil
			})}
			rows, err := discoverGeminiModels(context.Background(), client, base, "")
			want := 20
			if mode == "total bytes" {
				want = 5
			}
			if err == nil || rows != nil || calls != want {
				t.Fatalf("rows=%v calls=%d err=%v", rows, calls, err)
			}
		})
	}
}

func TestGeminiModelsEmptyCatalogCancellationAndStatus(t *testing.T) {
	base, _ := url.Parse("https://upstream.example")
	client := &http.Client{Transport: modelTransport(func(*http.Request) (*http.Response, error) { return modelResponse(`{"models":[]}`), nil })}
	rows, err := discoverGeminiModels(context.Background(), client, base, "")
	if err != nil || rows == nil || len(rows) != 0 {
		t.Fatalf("empty catalog rejected: %v %v", rows, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	client.Transport = modelTransport(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	if _, err = discoverGeminiModels(ctx, client, base, ""); err == nil || err.Error() != "upstream_unavailable" {
		t.Fatalf("cancellation lost: %v", err)
	}
	for _, status := range []int{302, 401, 429, 500} {
		client.Transport = modelTransport(func(*http.Request) (*http.Response, error) {
			response := modelResponse(`{"secret":"SECRET"}`)
			response.StatusCode = status
			return response, nil
		})
		if _, err = discoverGeminiModels(context.Background(), client, base, ""); err == nil || err.Error() != "upstream_unavailable" {
			t.Fatalf("status %d: %v", status, err)
		}
	}
}

func TestGeminiMixedProtocolPreviewRejectsBeforeDispatch(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	if root == "" {
		t.Fatal("MOTAI_CONTRACTS_DIR required")
	}
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	if err != nil {
		t.Fatal(err)
	}
	manager := &configview.Manager{Validator: validator}
	engine := gin.New()
	modelsRoutes(engine.Group("/internal/v1"), manager)
	response := httptest.NewRecorder()
	request := httptest.NewRequest("POST", "/internal/v1/models/preview", strings.NewReader(`{"format_version":1,"base_url":"https://upstream.example","credential":"SECRET","channel_id":null,"capabilities":["gemini_generate_content","responses"]}`))
	engine.ServeHTTP(response, request)
	var payload map[string]any
	if response.Code != 422 || json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload["error"].(map[string]any)["code"] != "unsupported_model" {
		t.Fatalf("mixed response %d %s", response.Code, response.Body.String())
	}
}

func TestGeminiOperatorPreviewAllowsPrivateHTTPButBlocksForbiddenAndRedirect(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	if root == "" {
		t.Fatal("MOTAI_CONTRACTS_DIR required")
	}
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls++
		if request.URL.Path != "/prefix/v1beta/models" || request.Header.Get("x-goog-api-key") != "SECRET" {
			t.Error("wrong native HTTP request")
		}
		writer.Header().Set("Content-Type", "application/json")
		io.WriteString(writer, `{"models":[{"name":"models/Gemini","supportedGenerationMethods":["generateContent"]}]}`)
	}))
	defer upstream.Close()
	service.InitHttpClient()
	invoke := func(base string, forbidden []string) *httptest.ResponseRecorder {
		engine := gin.New()
		modelsRoutes(engine.Group("/internal/v1"), &configview.Manager{Validator: validator, Forbidden: forbidden})
		response := httptest.NewRecorder()
		body, _ := json.Marshal(map[string]any{"format_version": 1, "base_url": base, "credential": "SECRET", "channel_id": nil, "capabilities": []string{"gemini_generate_content"}})
		engine.ServeHTTP(response, httptest.NewRequest("POST", "/internal/v1/models/preview", strings.NewReader(string(body))))
		if strings.Contains(response.Body.String(), "SECRET") {
			t.Fatal("credential leaked")
		}
		return response
	}
	response := invoke(upstream.URL+"/prefix", nil)
	if response.Code != 200 || calls != 1 || !strings.Contains(response.Body.String(), `"id":"Gemini"`) {
		t.Fatalf("legitimate operator HTTP preview rejected: %d calls=%d %s", response.Code, calls, response.Body.String())
	}
	response = invoke(upstream.URL+"/prefix", []string{upstream.URL})
	if response.Code != 400 || calls != 1 {
		t.Fatalf("forbidden target dispatched: %d calls=%d", response.Code, calls)
	}
	redirect := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, upstream.URL+"/prefix/v1beta/models", http.StatusFound)
	}))
	defer redirect.Close()
	response = invoke(redirect.URL, nil)
	if response.Code != 502 || calls != 1 {
		t.Fatalf("redirect followed: %d calls=%d", response.Code, calls)
	}
}

func TestGeminiPaginationKeepsOverallDeadline(t *testing.T) {
	base, _ := url.Parse("https://upstream.example")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	calls := 0
	client := &http.Client{Transport: modelTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		want, _ := ctx.Deadline()
		got, ok := request.Context().Deadline()
		if !ok || !want.Equal(got) {
			t.Fatal("page reset the total deadline")
		}
		if calls == 1 {
			return modelResponse(`{"models":[],"nextPageToken":"second"}`), nil
		}
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}
	if rows, err := discoverGeminiModels(ctx, client, base, ""); err == nil || rows != nil || calls != 2 {
		t.Fatalf("deadline result rows=%v calls=%d err=%v", rows, calls, err)
	}
}
