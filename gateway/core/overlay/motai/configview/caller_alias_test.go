package configview

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func callerAliasContractRoot(t *testing.T) string {
	t.Helper()
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	if root == "" {
		_, file, _, _ := runtime.Caller(0)
		for current := filepath.Dir(file); ; current = filepath.Dir(current) {
			if _, err := os.Stat(filepath.Join(current, "contracts", "fixtures", "caller-token-alias-vectors.json")); err == nil {
				root = filepath.Join(current, "contracts")
				break
			}
			if filepath.Dir(current) == current {
				t.Fatal("set MOTAI_CONTRACTS_DIR to the shared contracts directory")
			}
		}
	}
	return root
}

func TestImportedCallerAliasSharesFullIdentityRestrictions(t *testing.T) {
	root := callerAliasContractRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "fixtures", "caller-token-alias-vectors.json"))
	require.NoError(t, err)
	var fixtures struct {
		Authentication struct {
			HashKey        string   `json:"hash_key"`
			BareToken      string   `json:"bare_token"`
			PrefixedToken  string   `json:"prefixed_token"`
			PrimaryHMAC    string   `json:"primary_hmac"`
			AliasHMAC      string   `json:"alias_hmac"`
			RejectedTokens []string `json:"rejected_tokens"`
		} `json:"authentication"`
	}
	require.NoError(t, json.Unmarshal(data, &fixtures))
	vector := fixtures.Authentication
	key := []byte(vector.HashKey)
	require.Equal(t, vector.PrimaryHMAC, TokenHMAC(key, vector.BareToken))
	require.Equal(t, vector.AliasHMAC, TokenHMAC(key, vector.PrefixedToken))
	now := time.Date(2026, 10, 28, 0, 0, 0, 0, time.UTC)
	expiry := now.Add(time.Hour)
	caller := Caller{ID: "imported", Enabled: true, SubjectEnabled: true, TokenHMAC: vector.PrimaryHMAC, TokenHMACAliases: []string{vector.AliasHMAC},
		ExpiresAt: &expiry, AllowedIPs: []string{"192.0.2.0/24"},
		Permissions: []Permission{{PoolID: "pool", ModelIDs: []string{"Model"}, ChannelIDs: []string{"channel"}, Protocols: []string{"responses"}}}}
	view := &View{Config: Config{Callers: []Caller{caller}, Channels: []Channel{{ID: "channel", PoolID: "pool", Enabled: true,
		Models: []ChannelModel{{ModelID: "Model", UpstreamModel: "ProviderModel", Capabilities: []string{"responses", "messages"}}}}}}, Epochs: map[string]string{"pool": "1"}}
	for _, token := range []string{vector.BareToken, vector.PrefixedToken} {
		authenticated, err := view.Authenticate(key, token, "192.0.2.5", now)
		require.NoError(t, err)
		assert.Equal(t, caller, authenticated)
		selected, err := view.Candidates(authenticated, "Model", "responses", "", "")
		require.NoError(t, err)
		require.Len(t, selected, 1)
		_, err = view.Candidates(authenticated, "Model", "messages", "", "")
		assert.Error(t, err)
		_, err = view.Candidates(authenticated, "Other", "responses", "", "")
		assert.Error(t, err)
		_, err = view.Candidates(authenticated, "Model", "responses", "other", "")
		assert.Error(t, err)
		_, err = view.Authenticate(key, token, "198.51.100.5", now)
		assert.Error(t, err)
		_, err = view.Authenticate(key, token, "192.0.2.5", expiry)
		assert.Error(t, err)
		for _, disabled := range []Caller{func() Caller { c := caller; c.Enabled = false; return c }(), func() Caller { c := caller; c.SubjectEnabled = false; return c }()} {
			view.Config.Callers = []Caller{disabled}
			_, err = view.Authenticate(key, token, "192.0.2.5", now)
			assert.Error(t, err)
		}
		view.Config.Callers = []Caller{caller}
	}
	for _, token := range vector.RejectedTokens {
		_, err = view.Authenticate(key, token, "192.0.2.5", now)
		assert.Error(t, err)
	}
	freshToken := "sk-motai-SYNTHETIC_NEW_TOKEN"
	fresh := caller
	fresh.TokenHMAC = TokenHMAC(key, freshToken)
	fresh.TokenHMACAliases = nil
	view.Config.Callers = []Caller{fresh}
	for _, token := range []string{vector.BareToken, vector.PrefixedToken, "motai-SYNTHETIC_NEW_TOKEN", freshToken + "-007"} {
		_, err = view.Authenticate(key, token, "192.0.2.5", now)
		assert.Error(t, err)
	}
	_, err = view.Authenticate(key, freshToken, "192.0.2.5", now)
	require.NoError(t, err)
}

func TestImportedCallerAliasValidatedFileRoundTrip(t *testing.T) {
	root := callerAliasContractRoot(t)
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	require.NoError(t, err)
	read := func(name string) []byte {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(root, "fixtures", name))
		require.NoError(t, err)
		return data
	}
	var config map[string]any
	require.NoError(t, json.Unmarshal(read("config-valid.json"), &config))
	key, bare := []byte("stable-synthetic-hmac-key-for-tests"), "SYNTHETIC_LOAD_DATABASE_KEY"
	caller := config["callers"].([]any)[0].(map[string]any)
	caller["enabled"], caller["subject_enabled"], caller["expires_at"], caller["allowed_ips"] = true, true, nil, []any{}
	caller["token_hmac"] = TokenHMAC(key, bare)
	caller["token_hmac_aliases"] = []any{TokenHMAC(key, "sk-"+bare)}
	directory := t.TempDir()
	write := func(name string, data []byte) FileRef {
		t.Helper()
		require.NoError(t, os.WriteFile(filepath.Join(directory, name), data, 0600))
		hash := sha256.Sum256(data)
		return FileRef{File: name, SHA256: hex.EncodeToString(hash[:])}
	}
	load := func() (*View, error) {
		t.Helper()
		data, err := json.Marshal(config)
		require.NoError(t, err)
		manifest := Manifest{FormatVersion: 1, Gen: config["gen"].(string),
			Config: write("config.json", data), Credentials: write("credentials.json", read("credentials-valid.json"))}
		data, err = json.Marshal(manifest)
		require.NoError(t, err)
		view, _, err := Load(directory, write("manifest.json", data), validator, nil)
		return view, err
	}
	view, err := load()
	require.NoError(t, err)
	require.Equal(t, []string{TokenHMAC(key, "sk-"+bare)}, view.Config.Callers[0].TokenHMACAliases)
	for _, token := range []string{bare, "sk-" + bare} {
		authenticated, err := view.Authenticate(key, token, "192.0.2.5", time.Now())
		require.NoError(t, err)
		require.Equal(t, caller["id"], authenticated.ID)
	}
	caller["token_hmac_aliases"] = []any{TokenHMAC(key, bare)}
	_, err = load()
	require.Error(t, err, "domain rejects primary/alias collisions before serving")
	caller["token_hmac_aliases"] = []any{TokenHMAC(key, "sk-"+bare), TokenHMAC(key, "another")}
	_, err = load()
	require.Error(t, err, "wire schema bounds aliases to one before serving")
}
