package attempt

import (
	"context"
	"encoding/json"
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

func ledgerTestRuntime(t *testing.T) (*Runtime, []configview.Selection, func() Intent) {
	return ledgerTestRuntimeCapacity(t, 8)
}

func ledgerTestRuntimeCapacity(t *testing.T, capacity int) (*Runtime, []configview.Selection, func() Intent) {
	t.Helper()
	if os.Getenv("MOTAI_RUNTIME_DSN") == "" {
		t.Skip("requires isolated synthetic PostgreSQL")
	}
	db, err := store.Open(os.Getenv("MOTAI_RUNTIME_DSN"), os.Getenv("MOTAI_ACTIVATOR_DSN"))
	require.NoError(t, err)
	t.Cleanup(db.Close)
	validator, err := contract.NewValidator(filepath.Join(os.Getenv("MOTAI_CONTRACTS_DIR"), "v1"))
	require.NoError(t, err)
	r, err := New(context.Background(), db, validator, []byte("synthetic-lease-test-key-32-bytes"), capacity)
	require.NoError(t, err)
	t.Cleanup(r.Close)
	pool := "lease-" + uuid.NewString()
	_, err = db.Activator.Exec(`INSERT INTO motai.pool_state(pool_id,epoch,routing_fingerprint) VALUES($1,1,'test')`, pool)
	require.NoError(t, err)
	ref, version := "upstream", "1"
	view := &configview.View{Config: configview.Config{Gen: "3", Models: []configview.Model{{ID: "test-model", Vendor: "openai"}}}}
	view.Config.Affinity.TTLSeconds = 3600
	candidates := []configview.Selection{{View: view, Channel: configview.Channel{ID: "primary", Name: "primary", Priority: 10, CredentialRef: &ref, CredentialVersion: &version}, Pool: pool, Epoch: "1", Model: "test-model", UpstreamModel: "test-model", Protocol: "chat_completions"}}
	intent := func() Intent {
		return Intent{FormatVersion: 1, Source: "motai", RequestID: uuid.NewString(), AttemptID: uuid.NewString(), Kind: "model", Gen: "3", PoolEpoch: "1", CallerID: "caller", PoolID: pool, ModelRequested: "test-model", ModelCanonical: "test-model", Protocol: "chat_completions", StartedAt: time.Now().UTC(), AttemptNo: 1, Affinity: r.Scope("caller", pool, "test-model", "chat_completions", "1", "lease-test")}
	}
	return r, candidates, intent
}

func ledgerSuccess(intent Intent) Terminal {
	status := 200
	return Terminal{FormatVersion: 1, AttemptID: intent.AttemptID, EndedAt: time.Now().UTC(), DurationMS: 1, RequestOutcome: "succeeded", AttemptOutcome: "succeeded", SendCertainty: "full", UpstreamStatus: &status, ProtocolTerminal: "not_applicable", ChannelEffect: "none", Usage: usage.Normalize("unknown", map[string]int64{}, true)}
}

func terminateLease(t *testing.T, r *Runtime) {
	t.Helper()
	var terminated bool
	require.NoError(t, r.Store.Runtime.QueryRow(`SELECT pg_terminate_backend(lease_pid) FROM motai.runtime_lease WHERE singleton=1 AND boot_id=$1`, r.BootID).Scan(&terminated))
	require.True(t, terminated)
}

func TestPostgresRuntimeLeaseTakeoverFencesAllWrites(t *testing.T) {
	a, candidates, intent := ledgerTestRuntime(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_, err := New(ctx, a.Store, a.Validator, a.key, 8)
	require.EqualError(t, err, "runtime already active")
	_, admitted, err := a.Admit(ctx, candidates, intent(), "")
	require.NoError(t, err)
	probeID := uuid.NewString()
	_, created, err := a.ClaimProbe(ctx, probeID, []byte(`{"channel_id":"primary"}`), map[string]any{"state": "running"})
	require.NoError(t, err)
	require.True(t, created)
	// A write already holding the fence must finish before B may recover it.
	guarded, err := a.Store.Runtime.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer guarded.Rollback()
	require.NoError(t, a.guardLease(ctx, guarded))
	terminateLease(t, a)
	type takeover struct {
		runtime *Runtime
		err     error
	}
	result := make(chan takeover, 1)
	go func() {
		b, err := New(ctx, a.Store, a.Validator, a.key, 8)
		result <- takeover{b, err}
	}()
	require.Eventually(t, func() bool {
		var blocked bool
		err := a.Store.Runtime.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO motai.runtime_lease%')`).Scan(&blocked)
		return err == nil && blocked
	}, 3*time.Second, 20*time.Millisecond)
	select {
	case early := <-result:
		if early.runtime != nil {
			early.runtime.Close()
		}
		t.Fatal("takeover passed a live transaction fence", early.err)
	default:
	}
	require.NoError(t, guarded.Commit())
	var b *Runtime
	select {
	case value := <-result:
		require.NoError(t, value.err)
		b = value.runtime
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	defer b.Close()
	var raw []byte
	require.NoError(t, a.Store.Runtime.QueryRowContext(ctx, `SELECT terminal FROM motai.attempts WHERE attempt_id=$1`, admitted.AttemptID).Scan(&raw))
	var recovered Terminal
	require.NoError(t, json.Unmarshal(raw, &recovered))
	require.Equal(t, "interrupted", recovered.AttemptOutcome)
	require.Equal(t, "unknown", recovered.SendCertainty)
	require.Equal(t, "absent", recovered.Usage.TotalInput.Availability)
	var beforeSeq int64
	require.NoError(t, a.Store.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&beforeSeq))
	require.ErrorIs(t, a.commit(ctx, completion{admitted, ledgerSuccess(admitted), 3600}), errRuntimeFenced)
	_, _, err = a.Admit(ctx, candidates, intent(), "")
	require.EqualError(t, err, "gateway_log_unavailable")
	_, _, err = a.ClaimProbe(ctx, uuid.NewString(), []byte(`{}`), map[string]any{"state": "accepted"})
	require.ErrorIs(t, err, errRuntimeFenced)
	a.FinishProbe(ctx, probeID)
	var probeState string
	require.NoError(t, a.Store.Runtime.QueryRowContext(ctx, `SELECT response->>'state' FROM motai.probe_runs WHERE client_run_id=$1`, probeID).Scan(&probeState))
	require.Equal(t, "interrupted", probeState)
	a.Complete(admitted, ledgerSuccess(admitted), 3600)
	require.Eventually(t, func() bool {
		a.mu.Lock()
		defer a.mu.Unlock()
		return len(a.held) == 1
	}, time.Second, 10*time.Millisecond)
	a.SetAccepting(true)
	require.True(t, a.fenced.Load())
	require.EqualError(t, a.reserve(), "gateway_log_unavailable")
	var afterSeq, attempts int64
	require.NoError(t, a.Store.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&afterSeq))
	require.Equal(t, beforeSeq, afterSeq)
	require.NoError(t, a.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, admitted.PoolID).Scan(&attempts))
	require.EqualValues(t, 1, attempts, "recovery must not create a replacement attempt")
	_, fresh, err := b.Admit(ctx, candidates, intent(), "")
	require.NoError(t, err)
	b.Complete(fresh, ledgerSuccess(fresh), 3600)
	require.Eventually(t, func() bool { return b.pending.Load() == 0 }, time.Second, 10*time.Millisecond)
}

func TestPostgresRuntimeLeaseHeartbeatAndLockCheck(t *testing.T) {
	r, _, _ := ledgerTestRuntime(t)
	// Hold the monitor while checking the database lock directly, so the guard
	// cannot pass only because the heartbeat happened to notice first.
	var err error
	func() {
		r.leaseMu.Lock()
		defer r.leaseMu.Unlock()
		terminateLease(t, r)
		tx, beginErr := r.Store.Runtime.Begin()
		require.NoError(t, beginErr)
		defer tx.Rollback()
		err = r.guardLease(context.Background(), tx)
	}()
	require.ErrorIs(t, err, errRuntimeFenced)
	require.EqualError(t, r.reserve(), "gateway_log_unavailable")
}

func TestPostgresRuntimeLeaseHeartbeatStopsAdmission(t *testing.T) {
	r, _, _ := ledgerTestRuntime(t)
	terminateLease(t, r)
	require.Eventually(t, r.fenced.Load, 3*time.Second, 20*time.Millisecond)
	r.SetAccepting(true)
	require.EqualError(t, r.reserve(), "gateway_log_unavailable")
	require.Contains(t, r.Status(context.Background())["degraded_reasons"], "runtime_lease_lost")
}

func TestPostgresCompletionOldestWaitStopsAdmission(t *testing.T) {
	r, candidates, intent := ledgerTestRuntime(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_, admitted, err := r.Admit(ctx, candidates, intent(), "")
	require.NoError(t, err)
	blocker, err := r.Store.Runtime.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer blocker.Rollback()
	var seq int64
	require.NoError(t, blocker.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1 FOR UPDATE`).Scan(&seq))
	r.Complete(admitted, ledgerSuccess(admitted), 3600)
	require.Eventually(t, func() bool {
		return r.completionOverdue()
	}, 6*time.Second, 20*time.Millisecond)
	_, _, err = r.Admit(ctx, candidates, intent(), "")
	require.EqualError(t, err, "gateway_log_unavailable")
	require.Contains(t, r.Status(ctx)["degraded_reasons"], "completion_wait_exceeded")
	var count int
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, admitted.PoolID).Scan(&count))
	require.Equal(t, 1, count)
	require.Less(t, len(r.slots), cap(r.slots), "age gate must work before capacity is full")
	require.NoError(t, blocker.Commit())
	require.Eventually(t, func() bool { return r.pending.Load() == 0 && r.Accepting() }, 3*time.Second, 20*time.Millisecond)
	_, fresh, err := r.Admit(ctx, candidates, intent(), "")
	require.NoError(t, err)
	r.Complete(fresh, ledgerSuccess(fresh), 3600)
	require.Eventually(t, func() bool { return r.pending.Load() == 0 }, time.Second, 10*time.Millisecond)
	var finalSeq int64
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&finalSeq))
	require.Equal(t, seq+2, finalSeq, "retries must not duplicate terminal events")
}

func TestPostgresInFlightLimitIsSeparateFromCompletionCapacity(t *testing.T) {
	r, candidates, intent := ledgerTestRuntimeCapacity(t, 256)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	type admission struct {
		intent Intent
		err    error
	}
	results := make(chan admission, 64)
	var wg sync.WaitGroup
	for index := 0; index < 64; index++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, value, err := r.Admit(ctx, candidates, intent(), "")
			results <- admission{value, err}
		}()
	}
	wg.Wait()
	close(results)
	admitted := make([]Intent, 0, 64)
	for result := range results {
		require.NoError(t, result.err)
		admitted = append(admitted, result.intent)
	}
	require.Equal(t, 64, len(r.sendSlots))
	require.Equal(t, 64, len(r.slots))
	require.EqualValues(t, 64, r.inflight.Load())
	_, _, err := r.Admit(ctx, candidates, intent(), "")
	require.ErrorIs(t, err, ErrBusy)
	var count int
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE pool_id=$1`, admitted[0].PoolID).Scan(&count))
	require.Equal(t, 64, count, "65th request must be rejected before its intent")
	require.Contains(t, r.Status(ctx)["degraded_reasons"], "in_flight_limit")
	blocker, err := r.Store.Runtime.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer blocker.Rollback()
	var seq int64
	require.NoError(t, blocker.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1 FOR UPDATE`).Scan(&seq))
	r.Complete(admitted[0], ledgerSuccess(admitted[0]), 3600)
	require.Equal(t, 63, len(r.sendSlots))
	require.Equal(t, 64, len(r.slots), "completion reservation remains until durable commit")
	require.EqualValues(t, 1, r.pending.Load())
	_, next, err := r.Admit(ctx, candidates, intent(), "")
	require.NoError(t, err, "finished upstream frees a send slot before terminal commit")
	require.Equal(t, 64, len(r.sendSlots))
	require.Equal(t, 65, len(r.slots))
	_, _, err = r.Admit(ctx, candidates, intent(), "")
	require.ErrorIs(t, err, ErrBusy)
	require.NoError(t, blocker.Commit())
	for _, value := range append(admitted[1:], next) {
		r.Complete(value, ledgerSuccess(value), 3600)
	}
	require.Eventually(t, func() bool { return r.pending.Load() == 0 }, 3*time.Second, 10*time.Millisecond)
	require.Zero(t, len(r.sendSlots))
	require.Zero(t, len(r.slots))
	require.Zero(t, r.inflight.Load())
}
