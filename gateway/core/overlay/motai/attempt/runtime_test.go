package attempt

import (
	"context"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/store"
	"github.com/QuantumNous/new-api/motai/usage"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestPostgresRoutingAndTerminalTransactions(t *testing.T) {
	dsn := os.Getenv("MOTAI_RUNTIME_DSN")
	if dsn == "" {
		t.Skip("requires isolated synthetic PostgreSQL")
	}
	ctx := context.Background()
	db, err := store.Open(dsn, os.Getenv("MOTAI_ACTIVATOR_DSN"))
	require.NoError(t, err)
	defer db.Close()
	validator, err := contract.NewValidator(filepath.Join(os.Getenv("MOTAI_CONTRACTS_DIR"), "v1"))
	require.NoError(t, err)
	r, err := New(ctx, db, validator, []byte("synthetic-test-affinity-key-32-bytes"), 64)
	require.NoError(t, err)
	defer r.Close()
	pool := "test-" + uuid.NewString()
	_, err = db.Activator.ExecContext(ctx, `INSERT INTO motai.pool_state(pool_id,epoch,routing_fingerprint) VALUES($1,1,'test')`, pool)
	require.NoError(t, err)
	ref, version := "upstream", "1"
	view := &configview.View{Config: configview.Config{Gen: "3", Models: []configview.Model{{ID: "test-model", Vendor: "openai"}}}}
	view.Config.Affinity.TTLSeconds = 3600
	candidates := []configview.Selection{}
	for _, id := range []string{"primary", "backup"} {
		priority := 10
		if id == "backup" {
			priority = 9
		}
		candidates = append(candidates, configview.Selection{View: view, Channel: configview.Channel{ID: id, Name: id, Priority: priority, CredentialRef: &ref, CredentialVersion: &version}, Pool: pool, Epoch: "1", Model: "test-model", UpstreamModel: "test-model", Protocol: "chat_completions"})
	}
	makeIntent := func(scope string) Intent {
		return Intent{FormatVersion: 1, Source: "motai", RequestID: uuid.NewString(), AttemptID: uuid.NewString(), Kind: "model", Gen: "3", PoolEpoch: "1", CallerID: "caller", PoolID: pool, ModelRequested: "test-model", ModelCanonical: "test-model", Protocol: "chat_completions", StartedAt: time.Now().UTC(), AttemptNo: 1, Affinity: r.Scope("caller", pool, "test-model", "chat_completions", "1", scope)}
	}
	complete := func(intent Intent, success bool) Terminal {
		terminal := Terminal{1, intent.AttemptID, time.Now().UTC(), 1, nil, "failed", "upstream_rejected", "full", nil, "not_applicable", 0, str("upstream_5xx"), "none", usage.Normalize("unknown", map[string]int64{}, true), nil, nil}
		if success {
			status := 200
			terminal.UpstreamStatus = &status
			terminal.RequestOutcome = "succeeded"
			terminal.AttemptOutcome = "succeeded"
			terminal.ErrorClass = nil
		}
		require.NoError(t, r.commit(ctx, completion{intent, terminal, 3600}))
		r.inflight.Add(-1)
		<-r.slots
		<-r.sendSlots
		return terminal
	}
	t.Run("invalid-success-does-not-persist-or-advance-events", func(t *testing.T) {
		_, intent, err := r.Admit(ctx, candidates, makeIntent("invalid-success"), "")
		require.NoError(t, err)
		var before int64
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&before))
		invalid := Terminal{1, intent.AttemptID, time.Now().UTC(), 1, nil, "succeeded", "succeeded", "full", nil, "not_applicable", 0, nil, "none", usage.Normalize("unknown", map[string]int64{}, true), nil, nil}
		require.EqualError(t, r.commit(ctx, completion{intent, invalid, 3600}), "success_semantics_mismatch")
		var unfinished bool
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT terminal IS NULL FROM motai.attempts WHERE attempt_id=$1`, intent.AttemptID).Scan(&unfinished))
		require.True(t, unfinished)
		var after int64
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&after))
		require.Equal(t, before, after)
		complete(intent, true)
	})
	t.Run("three-failures-fourth-request-and-duplicate", func(t *testing.T) {
		var third Intent
		for index := 0; index < 3; index++ {
			selected, intent, err := r.Admit(ctx, candidates, makeIntent("threshold"), "")
			require.NoError(t, err)
			require.Equal(t, "primary", selected.Channel.ID)
			terminal := complete(intent, false)
			require.NoError(t, r.commit(ctx, completion{intent, terminal, 3600}))
			third = intent
		}
		selected, intent, err := r.Admit(ctx, candidates, makeIntent("threshold"), "")
		require.NoError(t, err)
		require.Equal(t, "backup", selected.Channel.ID)
		complete(intent, true)
		_, _, err = r.Admit(ctx, candidates[:1], makeIntent("threshold"), "")
		require.EqualError(t, err, "channel_temporarily_unavailable")
		_, _, err = r.Admit(ctx, candidates, makeIntent("threshold"), "primary")
		require.EqualError(t, err, "channel_temporarily_unavailable")
		var count int
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempt_events WHERE attempt_id=$1`, third.AttemptID).Scan(&count))
		require.Equal(t, 1, count)
		_, err = db.Runtime.ExecContext(ctx, `UPDATE motai.channel_cooldowns SET until_at=now()-interval '1 second' WHERE cooldown_key=$1`, cooldownKey(third))
		require.NoError(t, err)
		_, err = db.Runtime.ExecContext(ctx, `UPDATE motai.failure_windows SET window_started=now()-interval '61 seconds' WHERE scope_key=$1`, third.Affinity.Digest)
		require.NoError(t, err)
		selected, intent, err = r.Admit(ctx, candidates, makeIntent("threshold"), "")
		require.NoError(t, err)
		require.Equal(t, "primary", selected.Channel.ID)
		complete(intent, false)
		selected, intent, err = r.Admit(ctx, candidates, makeIntent("threshold"), "")
		require.NoError(t, err)
		require.Equal(t, "backup", selected.Channel.ID)
		complete(intent, true)
		probe := makeIntent("recovery-probe")
		probe.Kind = "probe"
		_, probe, err = r.Admit(ctx, candidates, probe, "primary")
		require.NoError(t, err)
		complete(probe, true)
		selected, intent, err = r.Admit(ctx, candidates, makeIntent("threshold"), "")
		require.NoError(t, err)
		require.Equal(t, "primary", selected.Channel.ID)
		complete(intent, true)
		_, err = db.Runtime.ExecContext(ctx, `DELETE FROM motai.channel_cooldowns WHERE cooldown_key=$1`, cooldownKey(third))
		require.NoError(t, err)
	})
	t.Run("success-reset-and-window-expiry", func(t *testing.T) {
		for _, scope := range []string{"reset", "window"} {
			for index := 0; index < 2; index++ {
				_, intent, err := r.Admit(ctx, candidates, makeIntent(scope), "")
				require.NoError(t, err)
				complete(intent, false)
			}
			if scope == "reset" {
				_, intent, err := r.Admit(ctx, candidates, makeIntent(scope), "")
				require.NoError(t, err)
				complete(intent, true)
			} else {
				_, err = db.Runtime.ExecContext(ctx, `UPDATE motai.failure_windows SET window_started=now()-interval '301 seconds' WHERE scope_key=$1`, makeIntent(scope).Affinity.Digest)
				require.NoError(t, err)
			}
			selected, intent, err := r.Admit(ctx, candidates, makeIntent(scope), "")
			require.NoError(t, err)
			require.Equal(t, "primary", selected.Channel.ID)
			complete(intent, false)
			var failures int
			require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT failures FROM motai.failure_windows WHERE scope_key=$1 AND channel_id='primary'`, intent.Affinity.Digest).Scan(&failures))
			require.Equal(t, 1, failures)
		}
	})
	t.Run("concurrent-first-binding-same-tier", func(t *testing.T) {
		equal := append([]configview.Selection(nil), candidates...)
		equal[1].Channel.Priority = 10
		intents := make(chan Intent, 16)
		errs := make(chan error, 16)
		var wg sync.WaitGroup
		for index := 0; index < 16; index++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, intent, err := r.Admit(ctx, equal, makeIntent("parallel"), "")
				errs <- err
				intents <- intent
			}()
		}
		wg.Wait()
		close(errs)
		close(intents)
		for err := range errs {
			require.NoError(t, err)
		}
		channel := ""
		for intent := range intents {
			if channel == "" {
				channel = intent.ChannelID
			}
			require.Equal(t, channel, intent.ChannelID)
			complete(intent, true)
		}
	})
	t.Run("unavailable-channel-retry-at-matches-eligible-cooldowns", func(t *testing.T) {
		primary := makeIntent("unavailable-retry-at")
		primary.ChannelID, primary.CredentialRef, primary.CredentialVersion = "primary", ref, version
		backup := primary
		backup.ChannelID = "backup"
		primaryUntil := time.Now().UTC().Truncate(time.Microsecond).Add(90 * time.Second)
		backupUntil := primaryUntil.Add(-30 * time.Second)
		for _, item := range []struct {
			intent Intent
			until  time.Time
		}{{primary, primaryUntil}, {backup, backupUntil}} {
			_, err := db.Runtime.ExecContext(ctx, `INSERT INTO motai.channel_cooldowns(cooldown_key,until_at) VALUES($1,$2) ON CONFLICT(cooldown_key) DO UPDATE SET until_at=excluded.until_at`, cooldownKey(item.intent), item.until)
			require.NoError(t, err)
		}
		defer func() {
			_, err := db.Runtime.ExecContext(ctx, `DELETE FROM motai.channel_cooldowns WHERE cooldown_key IN ($1,$2)`, cooldownKey(primary), cooldownKey(backup))
			require.NoError(t, err)
			_, err = db.Runtime.ExecContext(ctx, `UPDATE motai.channel_health SET state='available' WHERE pool_id=$1`, pool)
			require.NoError(t, err)
		}()
		var before int
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, pool).Scan(&before))
		reject := func(explicit string, expected time.Time) {
			_, _, err := r.Admit(ctx, candidates, makeIntent("unavailable-retry-at"), explicit)
			require.EqualError(t, err, "channel_temporarily_unavailable")
			var unavailable *ChannelUnavailableError
			require.ErrorAs(t, err, &unavailable)
			require.True(t, expected.Equal(unavailable.RetryAt), "retry_at=%s, expected=%s", unavailable.RetryAt, expected)
		}
		reject("", backupUntil)
		reject("primary", primaryUntil)
		_, err := db.Runtime.ExecContext(ctx, `INSERT INTO motai.channel_health(pool_id,channel_id,credential_ref,credential_version,state,revision,observed_at) VALUES($1,'backup',$2,$3,'auth_invalid',1,now())`, pool, ref, version)
		require.NoError(t, err)
		reject("", primaryUntil)
		reject("backup", time.Time{})
		_, err = db.Runtime.ExecContext(ctx, `INSERT INTO motai.channel_health(pool_id,channel_id,credential_ref,credential_version,state,revision,observed_at) VALUES($1,'primary',$2,$3,'auth_invalid',1,now())`, pool, ref, version)
		require.NoError(t, err)
		reject("", time.Time{})
		reject("unknown", time.Time{})
		var after int
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, pool).Scan(&after))
		require.Equal(t, before, after)
		require.Zero(t, r.inflight.Load())
		require.Empty(t, r.slots)
		require.Empty(t, r.sendSlots)
	})
	t.Run("old-epoch-does-not-mutate-binding", func(t *testing.T) {
		_, intent, err := r.Admit(ctx, candidates, makeIntent("old"), "")
		require.NoError(t, err)
		_, err = db.Activator.ExecContext(ctx, `UPDATE motai.pool_state SET epoch=2 WHERE pool_id=$1`, pool)
		require.NoError(t, err)
		complete(intent, false)
		var count int
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.failure_windows WHERE scope_key=$1`, intent.Affinity.Digest).Scan(&count))
		require.Zero(t, count)
	})
	t.Run("queue-capacity-rejects-before-intent", func(t *testing.T) {
		var before int
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, pool).Scan(&before))
		r.draining.Store(true)
		_, _, err := r.Admit(ctx, candidates, makeIntent("drain"), "")
		require.ErrorIs(t, err, ErrDraining)
		r.draining.Store(false)
		for len(r.slots) < cap(r.slots) {
			r.slots <- struct{}{}
		}
		_, _, err = r.Admit(ctx, candidates, makeIntent("full"), "")
		require.ErrorIs(t, err, ErrBusy)
		for len(r.slots) > 0 {
			<-r.slots
		}
		var after int
		require.NoError(t, db.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, pool).Scan(&after))
		require.Equal(t, before, after)
	})
}
