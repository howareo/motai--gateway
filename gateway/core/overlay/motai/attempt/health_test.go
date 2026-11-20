package attempt

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/store"
	"github.com/QuantumNous/new-api/motai/usage"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestPostgresDedicatedCooldownAndChannelHealth(t *testing.T) {
	if os.Getenv("MOTAI_RUNTIME_DSN") == "" {
		t.Skip("requires isolated synthetic PostgreSQL")
	}
	ctx := context.Background()
	db, err := store.Open(os.Getenv("MOTAI_RUNTIME_DSN"), os.Getenv("MOTAI_ACTIVATOR_DSN"))
	require.NoError(t, err)
	defer db.Close()
	validator, err := contract.NewValidator(filepath.Join(os.Getenv("MOTAI_CONTRACTS_DIR"), "v1"))
	require.NoError(t, err)
	for _, group := range []string{"retry-after", "dynamic-health", "old-completion"} {
		t.Run(group, func(t *testing.T) {
			r, err := New(ctx, db, validator, []byte("synthetic-health-test-key-32-bytes"), 64)
			require.NoError(t, err)
			defer r.Close()
			pool := "test-health-" + uuid.NewString()
			_, err = db.Activator.ExecContext(ctx, `INSERT INTO motai.pool_state(pool_id,epoch,routing_fingerprint) VALUES($1,1,'test')`, pool)
			require.NoError(t, err)
			ref, version := "upstream", "1"
			view := &configview.View{Config: configview.Config{Gen: "3", Models: []configview.Model{{ID: "test-model", Vendor: "openai"}}}}
			view.Config.Affinity.TTLSeconds = 3600
			candidates := []configview.Selection{}
			for index, id := range []string{"primary", "backup"} {
				candidates = append(candidates, configview.Selection{View: view, Pool: pool, Epoch: "1", Model: "test-model", UpstreamModel: "test-model", Protocol: "chat_completions", Channel: configview.Channel{ID: id, Name: id, Priority: 10 - index, CredentialRef: &ref, CredentialVersion: &version}})
			}
			intent := func(scope, kind, epoch string) Intent {
				return Intent{FormatVersion: 1, Source: "motai", RequestID: uuid.NewString(), AttemptID: uuid.NewString(), Kind: kind, Gen: "3", PoolEpoch: epoch, CallerID: "caller", PoolID: pool, ModelRequested: "test-model", ModelCanonical: "test-model", Protocol: "chat_completions", StartedAt: time.Now().UTC(), AttemptNo: 1, Affinity: r.Scope("caller", pool, "test-model", "chat_completions", epoch, scope)}
			}
			admit := func(scope, kind, epoch, explicit string) Intent {
				_, value, err := r.Admit(ctx, candidates, intent(scope, kind, epoch), explicit)
				require.NoError(t, err)
				return value
			}
			finish := func(i Intent, outcome string, deadline *time.Time) Terminal {
				status := 403
				code := outcome
				request := "failed"
				if outcome == "succeeded" {
					status, request = 200, "succeeded"
				}
				if outcome == "rate_limited" {
					status = 429
				}
				if outcome == "auth_invalid" {
					status = 401
				}
				if outcome == "upstream_rejected" {
					code = "unknown_upstream"
				}
				value := Terminal{FormatVersion: 1, AttemptID: i.AttemptID, EndedAt: time.Now().UTC(), DurationMS: 1, RequestOutcome: request, AttemptOutcome: outcome, SendCertainty: "full", UpstreamStatus: &status, ProtocolTerminal: "not_applicable", ErrorClass: str(code), ChannelEffect: "none", Usage: usage.Normalize("unknown", map[string]int64{}, true), RetryAfterUntil: deadline}
				if outcome == "succeeded" {
					value.ErrorClass = nil
				}
				require.NoError(t, r.commit(ctx, completion{i, value, 3600}))
				r.inflight.Add(-1)
				<-r.slots
				<-r.sendSlots
				var raw []byte
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT terminal FROM motai.attempts WHERE attempt_id=$1`, i.AttemptID).Scan(&raw))
				require.NoError(t, common.Unmarshal(raw, &value))
				return value
			}
			state := func() string {
				var state string
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT state FROM motai.channel_health WHERE pool_id=$1 AND channel_id='primary' AND credential_version='1'`, pool).Scan(&state))
				return state
			}
			if group == "retry-after" {
				oldSuccess := admit("old-success", "model", "1", "primary")
				first := admit("rate", "model", "1", "primary")
				until := time.Now().UTC().Add(45 * time.Second)
				value := finish(first, "rate_limited", &until)
				require.Equal(t, "cooldown", value.ChannelEffect)
				finish(oldSuccess, "succeeded", nil)
				var count int
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.failure_windows WHERE scope_key=$1`, first.Affinity.Digest).Scan(&count))
				require.Zero(t, count)
				selected, next, err := r.Admit(ctx, candidates, intent("different-caller-scope", "model", "1"), "")
				require.NoError(t, err)
				require.Equal(t, "backup", selected.Channel.ID)
				finish(next, "succeeded", nil)
				for _, set := range [][]configview.Selection{candidates, candidates[:1]} {
					_, _, err = r.Admit(ctx, set, intent("rate", "model", "1"), "primary")
					require.EqualError(t, err, "channel_temporarily_unavailable")
				}
				other := intent("other-model", "model", "1")
				other.ModelCanonical = "other-model"
				_, other, err = r.Admit(ctx, candidates, other, "primary")
				require.NoError(t, err)
				finish(other, "succeeded", nil)
				other = intent("other-protocol", "model", "1")
				other.Protocol = "responses"
				_, other, err = r.Admit(ctx, candidates, other, "primary")
				require.NoError(t, err)
				finish(other, "succeeded", nil)
				_, err = db.Runtime.ExecContext(ctx, `UPDATE motai.channel_cooldowns SET until_at=now()-interval '1 second' WHERE cooldown_key=$1`, cooldownKey(first))
				require.NoError(t, err)
				restored := admit("rate", "model", "1", "")
				require.Equal(t, "primary", restored.ChannelID)
				finish(restored, "succeeded", nil)
				invalid := admit("invalid-header", "model", "1", "")
				value = finish(invalid, "rate_limited", nil)
				require.Equal(t, "failure_counted", value.ChannelEffect)
				ordinary := admit("ordinary-403", "model", "1", "")
				value = finish(ordinary, "upstream_rejected", nil)
				require.Equal(t, "none", value.ChannelEffect)
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.channel_health WHERE pool_id=$1`, pool).Scan(&count))
				require.Zero(t, count)
			} else if group == "dynamic-health" {
				oldProbe := admit("probe-before-fault", "probe", "1", "primary")
				fault := admit("funds", "model", "1", "primary")
				value := finish(fault, "funds_exhausted", nil)
				require.Equal(t, "exhausted", value.ChannelEffect)
				require.NoError(t, r.commit(ctx, completion{fault, value, 3600}))
				var revision int64
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT revision FROM motai.channel_health WHERE pool_id=$1 AND channel_id='primary'`, pool).Scan(&revision))
				require.EqualValues(t, 1, revision)
				finish(oldProbe, "succeeded", nil)
				require.Equal(t, "exhausted", state())
				blocked := intent("other-protocol", "model", "1")
				blocked.Protocol = "responses"
				blocked.ModelCanonical = "other-model"
				_, _, err := r.Admit(ctx, candidates, blocked, "primary")
				require.EqualError(t, err, "channel_temporarily_unavailable")
				fallback := admit("funds", "model", "1", "")
				require.Equal(t, "backup", fallback.ChannelID)
				finish(fallback, "succeeded", nil)
				probe := admit("probe-after-fault", "probe", "1", "primary")
				value = finish(probe, "succeeded", nil)
				require.Equal(t, "success_reset", value.ChannelEffect)
				require.Equal(t, "available", state())
				fault = admit("auth", "model", "1", "primary")
				value = finish(fault, "auth_invalid", nil)
				require.Equal(t, "auth_invalid", value.ChannelEffect)
				probe = admit("auth-probe", "probe", "1", "primary")
				finish(probe, "succeeded", nil)
				require.Equal(t, "auth_invalid", state())
				_, err = db.Activator.ExecContext(ctx, `UPDATE motai.pool_state SET epoch=2 WHERE pool_id=$1`, pool)
				require.NoError(t, err)
				_, _, err = r.Admit(ctx, candidates, intent("same-credential-new-epoch", "model", "2"), "primary")
				require.EqualError(t, err, "channel_temporarily_unavailable")
				newVersion := "2"
				candidates[0].Channel.CredentialVersion = &newVersion
				fresh := admit("new-credential", "model", "2", "primary")
				finish(fresh, "succeeded", nil)
				require.Equal(t, "auth_invalid", state())
			} else {
				old := admit("old", "model", "1", "primary")
				_, err = db.Activator.ExecContext(ctx, `UPDATE motai.pool_state SET epoch=2 WHERE pool_id=$1`, pool)
				require.NoError(t, err)
				value := finish(old, "auth_invalid", nil)
				require.Equal(t, "none", value.ChannelEffect)
				var count int
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.channel_health WHERE pool_id=$1`, pool).Scan(&count))
				require.Zero(t, count)
				old = admit("old-rate", "model", "2", "primary")
				_, err = db.Activator.ExecContext(ctx, `UPDATE motai.pool_state SET epoch=3 WHERE pool_id=$1`, pool)
				require.NoError(t, err)
				until := time.Now().Add(time.Minute)
				value = finish(old, "rate_limited", &until)
				require.Equal(t, "none", value.ChannelEffect)
				require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.channel_cooldowns WHERE cooldown_key=$1`, cooldownKey(old)).Scan(&count))
				require.Zero(t, count)
			}
		})
	}
}
