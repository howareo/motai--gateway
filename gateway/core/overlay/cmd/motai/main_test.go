package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMotaiHealthReportsSignalDrainAndRecoveryWithoutStorage(t *testing.T) {
	var draining atomic.Bool
	view := &configview.View{}
	snapshots := 0
	accepting := true
	engine := gin.New()
	engine.GET("/healthz", motaiHealth(func() *configview.View { snapshots++; return view }, &draining, func() bool { return accepting }))
	check := func(status int, ok bool, isDraining bool) {
		t.Helper()
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
		assert.Equal(t, status, response.Code)
		var body map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &body))
		assert.Equal(t, ok, body["ok"])
		assert.Equal(t, isDraining, body["draining"] == true)
	}
	check(200, true, false)
	draining.Store(true)
	check(503, false, true)
	assert.Equal(t, 1, snapshots, "draining health does not read storage or snapshot")
	draining.Store(false)
	check(200, true, false)
	accepting = false
	check(503, false, false)
	accepting = true
	check(200, true, false)
	view = nil
	check(503, false, false)
}

func TestMotaiManagementTokenNormalizesOnlyTrailingLineEndings(t *testing.T) {
	key := strings.Repeat("m", 32)
	for _, ending := range []string{"", "\n", "\r\n", "\r\n\r\n"} {
		token, err := managementToken([]byte(key + ending))
		require.NoError(t, err)
		assert.Equal(t, key, token)
	}
	for _, input := range []string{strings.Repeat("m", 31) + "\n", key + "\ninside", key + "\rinside", "\n" + key} {
		_, err := managementToken([]byte(input))
		require.Error(t, err)
		assert.NotContains(t, err.Error(), input)
	}
}

func TestMotaiHMACSecretFilePreservesTrailingNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hmac.key")
	content := []byte(strings.Repeat("h", 32) + "\n")
	require.NoError(t, os.WriteFile(path, content, 0o600))
	t.Setenv("MOTAI_SYNTHETIC_HMAC_FILE", path)
	got, err := secretFile("MOTAI_SYNTHETIC_HMAC_FILE")
	require.NoError(t, err)
	assert.Equal(t, content, got)
	assert.NotEqual(t, configview.TokenHMAC(content, "synthetic-token"), configview.TokenHMAC([]byte(strings.Repeat("h", 32)), "synthetic-token"))
}
