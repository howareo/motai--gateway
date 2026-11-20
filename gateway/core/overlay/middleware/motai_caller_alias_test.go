package middleware

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestMotaiCallerAliasWireExtractionAndPublicModels(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	bare, prefixed := "SYNTHETIC_LEGACY_DATABASE_KEY", "sk-SYNTHETIC_LEGACY_DATABASE_KEY"
	view := &configview.View{Config: configview.Config{Models: []configview.Model{{ID: "Only"}},
		Channels: []configview.Channel{{ID: "channel", PoolID: "pool", Enabled: true,
			Models: []configview.ChannelModel{{ModelID: "Only", Capabilities: []string{"responses"}}}}},
		Callers: []configview.Caller{{ID: "imported", Enabled: true, SubjectEnabled: true,
			TokenHMAC: configview.TokenHMAC(key, bare), TokenHMACAliases: []string{configview.TokenHMAC(key, prefixed)},
			AllowedIPs: []string{"192.0.2.0/24"}, Permissions: []configview.Permission{{PoolID: "pool", ModelIDs: []string{"Only"},
				ChannelIDs: []string{"channel"}, Protocols: []string{"responses"}}}}}}}
	for _, token := range []string{bare, prefixed} {
		for _, transport := range []string{"bearer", "raw authorization", "x-api-key", "x-goog-api-key", "query fallback"} {
			t.Run(token[:2]+"/"+transport, func(t *testing.T) {
				target := "/v1/models"
				request := httptest.NewRequest(http.MethodGet, target, nil)
				switch transport {
				case "bearer":
					request.Header.Set("Authorization", "Bearer "+token)
				case "raw authorization":
					request.Header.Set("Authorization", token)
				case "query fallback":
					request = httptest.NewRequest(http.MethodGet, target+"?key="+url.QueryEscape(token), nil)
				default:
					request.Header.Set("Authorization", "Bearer INVALID")
					request.Header.Set(transport, token)
				}
				request.RemoteAddr = "192.0.2.5:1234"
				ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
				ctx.Request = request
				// MotaiView and MotaiModels use this same exact-wire extractor.
				require.Equal(t, token, motaiToken(ctx))
				caller, err := view.Authenticate(key, motaiToken(ctx), "192.0.2.5", time.Now())
				require.NoError(t, err)
				require.Equal(t, "imported", caller.ID)
				engine := gin.New()
				require.NoError(t, engine.SetTrustedProxies(nil))
				engine.GET("/v1/models", MotaiModels(func() *configview.View { return view }, key))
				response := httptest.NewRecorder()
				engine.ServeHTTP(response, request)
				require.Equal(t, http.StatusOK, response.Code)
				require.Contains(t, response.Body.String(), `"id":"Only"`)
				for _, secret := range []string{bare, prefixed, "token_hmac", view.Config.Callers[0].TokenHMAC, view.Config.Callers[0].TokenHMACAliases[0]} {
					require.NotContains(t, response.Body.String(), secret)
				}
			})
		}
	}
	for _, token := range []string{prefixed + "-007", "sk-" + prefixed, bare + "-007", strings.ToLower(prefixed)} {
		ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
		ctx.Request = httptest.NewRequest(http.MethodGet, "/v1/models", nil)
		ctx.Request.Header.Set("Authorization", "Bearer "+token)
		require.Equal(t, token, motaiToken(ctx), "no prefix, suffix, or case normalization")
		_, err := view.Authenticate(key, motaiToken(ctx), "192.0.2.5", time.Now())
		require.Error(t, err)
	}
	for _, blocked := range []string{"disabled", "subject disabled", "expired", "IP denied", "rotated"} {
		t.Run(blocked, func(t *testing.T) {
			copyView := *view
			copyView.Config = view.Config
			copyView.Config.Callers = append([]configview.Caller(nil), view.Config.Callers...)
			caller := &copyView.Config.Callers[0]
			switch blocked {
			case "disabled":
				caller.Enabled = false
			case "subject disabled":
				caller.SubjectEnabled = false
			case "expired":
				expiry := time.Now().Add(-time.Second)
				caller.ExpiresAt = &expiry
			case "IP denied":
				caller.AllowedIPs = []string{"198.51.100.0/24"}
			case "rotated":
				caller.TokenHMAC = configview.TokenHMAC(key, "sk-motai-FRESH")
				caller.TokenHMACAliases = nil
			}
			for _, token := range []string{bare, prefixed} {
				engine := gin.New()
				require.NoError(t, engine.SetTrustedProxies(nil))
				engine.GET("/v1/models", MotaiModels(func() *configview.View { return &copyView }, key))
				request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
				request.RemoteAddr = "192.0.2.5:1234"
				request.Header.Set("Authorization", "Bearer "+token)
				response := httptest.NewRecorder()
				engine.ServeHTTP(response, request)
				require.Equal(t, http.StatusUnauthorized, response.Code)
			}
		})
	}
}
