package middleware

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func publicModelsFixture() (*configview.View, []byte, string) {
	key, token := []byte(strings.Repeat("k", 32)), "synthetic-model-caller"
	view := &configview.View{Config: configview.Config{Gen: "1",
		Models: []configview.Model{{ID: "Beta"}, {ID: "Alpha"}, {ID: "Shared"}, {ID: "Disabled"},
			{ID: "CountOnly"}, {ID: "WrongProtocol"}, {ID: "GroupOnly"}, {ID: "Private"}, {ID: "Unreachable"}},
		Aliases: []configview.Alias{{Alias: "alpha-alias", ModelID: "Alpha", PoolID: "a"},
			{Alias: "friendly", ModelID: "Alpha", PoolID: "a"}, {Alias: "friendly", ModelID: "Shared", PoolID: "b"}},
		Channels: []configview.Channel{
			{ID: "a", PoolID: "a", Enabled: true, Secret: "UPSTREAM_SECRET", BaseURL: "https://private.invalid", Models: []configview.ChannelModel{
				{ModelID: "Alpha", UpstreamModel: "UPSTREAM_ALPHA", Capabilities: []string{"responses"}},
				{ModelID: "Shared", Capabilities: []string{"responses"}}, {ModelID: "CountOnly", Capabilities: []string{"count_tokens"}},
				{ModelID: "WrongProtocol", Capabilities: []string{"responses"}}, {ModelID: "GroupOnly", Capabilities: []string{"responses"}},
				{ModelID: "Private", Capabilities: []string{"responses"}}}},
			{ID: "b", PoolID: "b", Enabled: true, Models: []configview.ChannelModel{
				{ModelID: "Beta", Capabilities: []string{"messages"}}, {ModelID: "Shared", Capabilities: []string{"responses"}}}},
			{ID: "disabled", PoolID: "a", Enabled: false, Models: []configview.ChannelModel{{ModelID: "Disabled", Capabilities: []string{"responses"}}}},
		},
		Callers: []configview.Caller{{ID: "caller", Enabled: true, SubjectEnabled: true, TokenHMAC: configview.TokenHMAC(key, token), Permissions: []configview.Permission{
			{PoolID: "a", ModelIDs: []string{"Alpha", "Shared", "CountOnly", "Disabled"}, ChannelIDs: []string{"a", "disabled"}, Protocols: []string{"responses", "count_tokens"}},
			{PoolID: "b", ModelIDs: []string{"Beta", "Shared"}, ChannelIDs: []string{"b"}, Protocols: []string{"messages", "responses"}},
			{PoolID: "a", ModelIDs: []string{"WrongProtocol"}, ChannelIDs: []string{"a"}, Protocols: []string{"messages"}},
			{PoolID: "a", ModelIDs: []string{"GroupOnly"}, ChannelIDs: []string{"a"}, Protocols: []string{"responses"}, Groups: []string{"named"}},
		}}},
	}}
	return view, key, token
}

func requestPublicModels(t *testing.T, snapshot func() *configview.View, key []byte, target, ip string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	engine := gin.New()
	require.NoError(t, engine.SetTrustedProxies(nil))
	engine.GET("/v1/models", MotaiModels(snapshot, key))
	request := httptest.NewRequest(http.MethodGet, target, nil)
	request.RemoteAddr = ip + ":1234"
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	assert.Empty(t, response.Header().Get("X-Motai-Attempt-Id"))
	return response
}

func listedModelIDs(t *testing.T, response *httptest.ResponseRecorder) []string {
	t.Helper()
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	var list struct {
		Object string             `json:"object"`
		Data   []motaiPublicModel `json:"data"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &list))
	assert.Equal(t, "list", list.Object)
	require.NotNil(t, list.Data, "empty results must serialize as [] rather than null")
	ids := []string{}
	for _, model := range list.Data {
		assert.Equal(t, "model", model.Object)
		assert.Zero(t, model.Created)
		assert.Equal(t, "motai", model.OwnedBy)
		ids = append(ids, model.ID)
	}
	var raw map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &raw))
	assert.Len(t, raw, 2)
	var rows []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(raw["data"], &rows))
	for _, row := range rows {
		assert.Len(t, row, 4, "public models contain no route or credential fields")
	}
	return ids
}

func TestMotaiModelsReachabilityAliasesPoolAndPrivacy(t *testing.T) {
	view, key, token := publicModelsFixture()
	before, err := json.Marshal(view)
	require.NoError(t, err)
	for _, fixture := range []struct {
		pool string
		ids  []string
	}{
		{"", []string{"Alpha", "Beta", "alpha-alias"}},
		{"a", []string{"Alpha", "Shared", "alpha-alias", "friendly"}},
		{"b", []string{"Beta", "Shared", "friendly"}},
		{"unknown", []string{}},
	} {
		t.Run("pool="+fixture.pool, func(t *testing.T) {
			snapshots := 0
			response := requestPublicModels(t, func() *configview.View { snapshots++; return view }, key, "/v1/models", "192.0.2.1",
				map[string]string{"Authorization": "Bearer " + token, "X-Motai-Pool": fixture.pool})
			assert.Equal(t, fixture.ids, listedModelIDs(t, response))
			assert.Equal(t, 1, snapshots)
			for _, secret := range []string{"UPSTREAM_SECRET", "UPSTREAM_ALPHA", "private.invalid", "token_hmac", "channel_id", "pool_id"} {
				assert.NotContains(t, response.Body.String(), secret)
			}
		})
	}
	after, err := json.Marshal(view)
	require.NoError(t, err)
	assert.Equal(t, before, after, "model discovery does not mutate the snapshot")
}

func TestMotaiModelsAuthenticationTokenPrecedenceAndBoundaries(t *testing.T) {
	for _, name := range []string{"bearer", "raw authorization preserved", "x-api-key overrides", "x-goog-api-key overrides", "query fallback", "query cannot override", "wrong goog overrides", "anonymous", "invalid", "disabled", "subject disabled", "expired", "IP denied", "CIDR allowed", "empty permissions"} {
		t.Run(name, func(t *testing.T) {
			view, key, token := publicModelsFixture()
			headers := map[string]string{"Authorization": "Bearer " + token}
			target, status := "/v1/models", http.StatusOK
			switch name {
			case "raw authorization preserved":
				headers["Authorization"] = token
			case "x-api-key overrides":
				headers["Authorization"], headers["x-api-key"] = "Bearer invalid", token
			case "x-goog-api-key overrides":
				headers["x-api-key"], headers["x-goog-api-key"] = "invalid", token
			case "query fallback":
				headers = nil
				target += "?key=" + token
			case "query cannot override":
				headers["Authorization"] = "Bearer invalid"
				target += "?key=" + token
				status = http.StatusUnauthorized
			case "wrong goog overrides":
				headers["x-goog-api-key"] = "invalid"
				status = http.StatusUnauthorized
			case "anonymous":
				headers, status = nil, http.StatusUnauthorized
			case "invalid":
				headers["Authorization"], status = "Bearer invalid", http.StatusUnauthorized
			case "disabled":
				view.Config.Callers[0].Enabled, status = false, http.StatusUnauthorized
			case "subject disabled":
				view.Config.Callers[0].SubjectEnabled, status = false, http.StatusUnauthorized
			case "expired":
				expired := time.Now().Add(-time.Second)
				view.Config.Callers[0].ExpiresAt, status = &expired, http.StatusUnauthorized
			case "IP denied":
				view.Config.Callers[0].AllowedIPs, status = []string{"198.51.100.0/24"}, http.StatusUnauthorized
			case "CIDR allowed":
				view.Config.Callers[0].AllowedIPs = []string{"192.0.2.0/24"}
			case "empty permissions":
				view.Config.Callers[0].Permissions = nil
			}
			response := requestPublicModels(t, func() *configview.View { return view }, key, target, "192.0.2.1", headers)
			require.Equal(t, status, response.Code)
			if status == http.StatusUnauthorized {
				assert.Contains(t, response.Body.String(), "permission_denied")
				assert.NotContains(t, response.Body.String(), token)
			} else if name == "empty permissions" {
				assert.Empty(t, listedModelIDs(t, response))
			}
		})
	}
}

func TestMotaiModelsUnavailableAndSnapshotReplacement(t *testing.T) {
	view, key, token := publicModelsFixture()
	current := (*configview.View)(nil)
	snapshot := func() *configview.View { return current }
	headers := map[string]string{"Authorization": "Bearer " + token}
	response := requestPublicModels(t, snapshot, key, "/v1/models", "192.0.2.1", headers)
	assert.Equal(t, http.StatusServiceUnavailable, response.Code)
	assert.Contains(t, response.Body.String(), "gateway_not_ready")
	current = view
	response = requestPublicModels(t, snapshot, key, "/v1/models", "192.0.2.1", headers)
	assert.Equal(t, []string{"Alpha", "Beta", "alpha-alias"}, listedModelIDs(t, response))
	copyView := *view
	copyView.Config = view.Config
	copyView.Config.Channels = nil
	current = &copyView
	response = requestPublicModels(t, snapshot, key, "/v1/models", "192.0.2.1", headers)
	assert.Empty(t, listedModelIDs(t, response))
}

func TestMotaiModelsListsEachGenerativeProtocol(t *testing.T) {
	for _, protocol := range []string{"responses", "chat_completions", "messages", "gemini_generate_content"} {
		t.Run(protocol, func(t *testing.T) {
			view, key, token := publicModelsFixture()
			view.Config.Models = []configview.Model{{ID: "Only"}}
			view.Config.Aliases = nil
			view.Config.Channels = []configview.Channel{{ID: "channel", PoolID: "pool", Enabled: true, Models: []configview.ChannelModel{{ModelID: "Only", Capabilities: []string{protocol}}}}}
			view.Config.Callers[0].Permissions = []configview.Permission{{PoolID: "pool", ModelIDs: []string{"Only"}, ChannelIDs: []string{"channel"}, Protocols: []string{protocol}}}
			response := requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", map[string]string{"Authorization": "Bearer " + token})
			assert.Equal(t, []string{"Only"}, listedModelIDs(t, response))
		})
	}
}

func TestMotaiModelsWildcardListsWhatTheListedChannelsOffer(t *testing.T) {
	view, key, token := publicModelsFixture()
	view.Config.Callers[0].Permissions = []configview.Permission{
		{PoolID: "a", ModelIDs: []string{"*"}, ChannelIDs: []string{"a", "disabled"}, Protocols: []string{"responses", "count_tokens"}},
		{PoolID: "b", ModelIDs: []string{"*"}, ChannelIDs: []string{"b"}, Protocols: []string{"messages", "responses"}},
	}
	headers := map[string]string{"Authorization": "Bearer " + token}
	for _, fixture := range []struct {
		pool string
		ids  []string
	}{
		// CountOnly has only count_tokens, which /v1/models never lists; Disabled sits on a disabled channel.
		{"a", []string{"Alpha", "GroupOnly", "Private", "Shared", "WrongProtocol", "alpha-alias", "friendly"}},
		{"b", []string{"Beta", "Shared", "friendly"}},
		{"", []string{"Alpha", "Beta", "GroupOnly", "Private", "WrongProtocol", "alpha-alias"}},
	} {
		t.Run("pool="+fixture.pool, func(t *testing.T) {
			headers["X-Motai-Pool"] = fixture.pool
			response := requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
			assert.Equal(t, fixture.ids, listedModelIDs(t, response))
		})
	}
	// A model added to a listed channel later appears with no permission change.
	view.Config.Models = append(view.Config.Models, configview.Model{ID: "Fresh"})
	view.Config.Channels[0].Models = append(view.Config.Channels[0].Models, configview.ChannelModel{ModelID: "Fresh", Capabilities: []string{"responses"}})
	headers["X-Motai-Pool"] = "a"
	response := requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
	assert.Contains(t, listedModelIDs(t, response), "Fresh")
	// A model that no listed channel offers stays hidden.
	view.Config.Models = append(view.Config.Models, configview.Model{ID: "Nowhere"})
	response = requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
	assert.NotContains(t, listedModelIDs(t, response), "Nowhere")
}

func TestMotaiModelsFullWildcardListsEveryEnabledChannelModelOfThePool(t *testing.T) {
	view, key, token := publicModelsFixture()
	view.Config.Callers[0].Permissions = []configview.Permission{
		{PoolID: "a", ModelIDs: []string{"*"}, ChannelIDs: []string{"*"}, Protocols: []string{"*"}},
		{PoolID: "b", ModelIDs: []string{"*"}, ChannelIDs: []string{"*"}, Protocols: []string{"*"}},
	}
	headers := map[string]string{"Authorization": "Bearer " + token}
	for _, fixture := range []struct {
		pool string
		ids  []string
	}{
		// The disabled channel's model never appears and CountOnly offers only count_tokens, which /v1/models never lists.
		{"a", []string{"Alpha", "GroupOnly", "Private", "Shared", "WrongProtocol", "alpha-alias", "friendly"}},
		{"b", []string{"Beta", "Shared", "friendly"}},
		{"", []string{"Alpha", "Beta", "GroupOnly", "Private", "WrongProtocol", "alpha-alias"}},
	} {
		t.Run("pool="+fixture.pool, func(t *testing.T) {
			headers["X-Motai-Pool"] = fixture.pool
			response := requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
			assert.Equal(t, fixture.ids, listedModelIDs(t, response))
		})
	}
	// A channel added to pool a later, with a model nobody listed before, shows up without touching the caller.
	view.Config.Models = append(view.Config.Models, configview.Model{ID: "Fresh"})
	view.Config.Channels = append(view.Config.Channels, configview.Channel{ID: "fresh", PoolID: "a", Enabled: true,
		Models: []configview.ChannelModel{{ModelID: "Fresh", Capabilities: []string{"responses"}}}})
	headers["X-Motai-Pool"] = "a"
	response := requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
	assert.Contains(t, listedModelIDs(t, response), "Fresh")
	// A channel of a pool the caller has no permission for stays invisible.
	view.Config.Callers[0].Permissions = view.Config.Callers[0].Permissions[:1]
	headers["X-Motai-Pool"] = ""
	response = requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
	assert.NotContains(t, listedModelIDs(t, response), "Beta")
}

func TestMotaiModelsWildcardChannelsAndProtocolsKeepEachOtherInCheck(t *testing.T) {
	view, key, token := publicModelsFixture()
	headers := map[string]string{"Authorization": "Bearer " + token, "X-Motai-Pool": "a"}
	for _, fixture := range []struct {
		name        string
		permission  configview.Permission
		wantPresent []string
		wantMissing []string
	}{
		// Channel wildcard with an explicit protocol: only models with that protocol, from any enabled channel of pool a.
		{"channels only", configview.Permission{PoolID: "a", ModelIDs: []string{"Alpha", "Shared"}, ChannelIDs: []string{"*"}, Protocols: []string{"responses"}},
			[]string{"Alpha", "Shared", "alpha-alias", "friendly"}, []string{"Private", "Disabled"}},
		// Protocol wildcard with an explicit channel: every protocol, but only that channel's models.
		{"protocols only", configview.Permission{PoolID: "a", ModelIDs: []string{"*"}, ChannelIDs: []string{"disabled"}, Protocols: []string{"*"}},
			nil, []string{"Alpha", "Disabled", "Shared"}},
		{"protocols and models", configview.Permission{PoolID: "a", ModelIDs: []string{"Alpha"}, ChannelIDs: []string{"a"}, Protocols: []string{"*"}},
			[]string{"Alpha", "alpha-alias", "friendly"}, []string{"Shared", "Private"}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			view.Config.Callers[0].Permissions = []configview.Permission{fixture.permission}
			response := requestPublicModels(t, func() *configview.View { return view }, key, "/v1/models", "192.0.2.1", headers)
			ids := listedModelIDs(t, response)
			for _, id := range fixture.wantPresent {
				assert.Contains(t, ids, id)
			}
			for _, id := range fixture.wantMissing {
				assert.NotContains(t, ids, id)
			}
		})
	}
}
