package attempt

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/store"
	"github.com/QuantumNous/new-api/motai/usage"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestClaudePrimaryUsesConfiguredPriorityAndStableID(t *testing.T) {
	view := &configview.View{Config: configview.Config{Channels: []configview.Channel{
		{ID: "other", PoolID: "openai", Priority: 100},
		{ID: "z", PoolID: "claude", Priority: 9, Weight: 100},
		{ID: "a", PoolIDs: []string{"openai", "claude"}, Priority: 1, PoolPriorities: map[string]int{"claude": 9}},
	}}}
	require.Equal(t, "a", claudePrimary(view))
	view.Config.Channels[1].Priority = 10
	require.Equal(t, "z", claudePrimary(view), "disabled channels still define the configured primary")
}

func TestPostgresClaudeUsesOnlyConfiguredPrimary(t *testing.T) {
	if os.Getenv("MOTAI_RUNTIME_DSN") == "" {
		t.Skip("requires isolated synthetic PostgreSQL")
	}
	ctx := context.Background()
	db, err := store.Open(os.Getenv("MOTAI_RUNTIME_DSN"), os.Getenv("MOTAI_ACTIVATOR_DSN"))
	require.NoError(t, err)
	defer db.Close()
	validator, err := contract.NewValidator(filepath.Join(os.Getenv("MOTAI_CONTRACTS_DIR"), "v1"))
	require.NoError(t, err)
	r, err := New(ctx, db, validator, []byte("synthetic-claude-fixed-routing-key"), 64)
	require.NoError(t, err)
	defer r.Close()
	var epoch string
	require.NoError(t, db.Activator.QueryRowContext(ctx, `INSERT INTO motai.pool_state(pool_id,epoch,routing_fingerprint) VALUES('claude',1,'test') ON CONFLICT(pool_id) DO UPDATE SET routing_fingerprint=motai.pool_state.routing_fingerprint RETURNING epoch::text`).Scan(&epoch))
	ref, version := "upstream", "1"
	view := &configview.View{Config: configview.Config{Gen: "3", Models: []configview.Model{{ID: "test-model", Vendor: "anthropic"}}}, Epochs: map[string]string{"claude": epoch}}
	view.Config.Affinity.TTLSeconds = 3600
	for index, id := range []string{"primary", "backup"} {
		view.Config.Channels = append(view.Config.Channels, configview.Channel{ID: id, Name: id, PoolID: "claude", Enabled: true, Priority: 10 - index, CredentialRef: &ref, CredentialVersion: &version,
			Models: []configview.ChannelModel{{ModelID: "test-model", UpstreamModel: "test-model", Capabilities: []string{"messages"}}}})
	}
	caller := configview.Caller{Permissions: []configview.Permission{{PoolID: "claude", ModelIDs: []string{"*"}, ChannelIDs: []string{"*"}, Protocols: []string{"messages"}}}}
	intent := func() Intent {
		return Intent{FormatVersion: 1, Source: "motai", RequestID: uuid.NewString(), AttemptID: uuid.NewString(), Kind: "model", Gen: "3", PoolEpoch: epoch, CallerID: "caller", PoolID: "claude", ModelRequested: "test-model", ModelCanonical: "test-model", Protocol: "messages", StartedAt: time.Now().UTC(), AttemptNo: 1, Affinity: r.Scope("caller", "claude", "test-model", "messages", epoch, "fixed-test")}
	}
	admit := func(explicit string) (Intent, error) {
		candidates, err := view.Candidates(caller, "test-model", "messages", "claude", "")
		require.NoError(t, err)
		_, value, err := r.Admit(ctx, candidates, intent(), explicit)
		return value, err
	}
	finish := func(value Intent, outcome string) {
		status, errorClass := 503, "upstream_5xx"
		var until *time.Time
		if outcome == "rate_limited" {
			status, errorClass = 429, "rate_limited"
			deadline := time.Now().Add(time.Minute)
			until = &deadline
		} else if outcome == "auth_invalid" {
			status, errorClass = 401, "auth_invalid"
		}
		terminal := Terminal{FormatVersion: 1, AttemptID: value.AttemptID, EndedAt: time.Now().UTC(), DurationMS: 1, RequestOutcome: "failed", AttemptOutcome: outcome, SendCertainty: "full", UpstreamStatus: &status, ProtocolTerminal: "not_applicable", ErrorClass: str(errorClass), ChannelEffect: "none", Usage: usage.Normalize("unknown", map[string]int64{}, true), RetryAfterUntil: until}
		require.NoError(t, r.commit(ctx, completion{value, terminal, 3600}))
		r.inflight.Add(-1)
		<-r.slots
		<-r.sendSlots
	}
	first := intent()
	_, err = db.Runtime.ExecContext(ctx, `INSERT INTO motai.affinity_bindings(scope_key,pool_id,epoch,channel_id,credential_version,expires_at) VALUES($1,'claude',$2,'backup','1',now()-interval '1 second') ON CONFLICT(scope_key) DO UPDATE SET channel_id='backup',expires_at=excluded.expires_at`, first.Affinity.Digest, epoch)
	require.NoError(t, err)
	for index := 0; index < 4; index++ {
		value, err := admit("")
		require.NoError(t, err)
		require.Equal(t, "primary", value.ChannelID)
		require.Equal(t, "priority_weight", value.RouteReason)
		finish(value, "upstream_rejected")
	}
	value, err := admit("")
	require.NoError(t, err)
	finish(value, "rate_limited")
	var count int
	require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.failure_windows WHERE scope_key=$1`, first.Affinity.Digest).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.channel_cooldowns WHERE cooldown_key=$1`, cooldownKey(value)).Scan(&count))
	require.Zero(t, count)
	_, err = db.Runtime.ExecContext(ctx, `INSERT INTO motai.channel_cooldowns(cooldown_key,until_at) VALUES($1,now()+interval '60 seconds')`, cooldownKey(value))
	require.NoError(t, err)
	value, err = admit("")
	require.NoError(t, err)
	require.Equal(t, "primary", value.ChannelID, "historical cooldown must not select backup or block primary")
	finish(value, "upstream_rejected")
	value, err = admit("backup")
	require.NoError(t, err)
	require.Equal(t, "backup", value.ChannelID)
	require.Equal(t, "explicit_channel", value.RouteReason)
	finish(value, "upstream_rejected")
	value, err = admit("")
	require.NoError(t, err)
	require.Equal(t, "primary", value.ChannelID, "old manual override must not replace the configured primary")
	finish(value, "upstream_rejected")
	view.Config.Channels[1].Priority = 11
	value, err = admit("")
	require.NoError(t, err)
	require.Equal(t, "backup", value.ChannelID, "manual primary change takes effect")
	finish(value, "upstream_rejected")
	view.Config.Channels[1].Enabled = false
	_, err = admit("")
	require.EqualError(t, err, "channel_temporarily_unavailable")
	view.Config.Channels[1].Enabled = true
	models := view.Config.Channels[1].Models
	view.Config.Channels[1].Models = nil
	_, err = admit("")
	require.EqualError(t, err, "channel_temporarily_unavailable", "unsupported primary model must not select another channel")
	view.Config.Channels[1].Models = models
	value, err = admit("")
	require.NoError(t, err)
	finish(value, "auth_invalid")
	_, err = admit("")
	require.EqualError(t, err, "channel_temporarily_unavailable")
	var bound string
	require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT channel_id FROM motai.affinity_bindings WHERE scope_key=$1`, first.Affinity.Digest).Scan(&bound))
	require.Equal(t, "backup", bound, "hard health failure must preserve binding")
	value, err = admit("primary")
	require.NoError(t, err)
	require.Equal(t, "primary", value.ChannelID)
	finish(value, "upstream_rejected")
}
