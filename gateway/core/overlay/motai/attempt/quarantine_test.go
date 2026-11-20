package attempt

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/usage"
	"github.com/stretchr/testify/require"
)

func TestPostgresProbeContractQuarantine(t *testing.T) {
	r, candidates, intent := ledgerTestRuntime(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var beforeSeq, beforeQuarantined int64
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&beforeSeq))
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.probe_completion_quarantine`).Scan(&beforeQuarantined))
	probe := intent()
	probe.Kind, probe.Gen = "probe", "737373"
	_, probe, err := r.Admit(ctx, candidates, probe, "primary")
	require.NoError(t, err)
	invalid := ledgerSuccess(probe)
	invalid.RequestOutcome, invalid.AttemptOutcome = "failed", "auth_invalid"
	invalid.ErrorClass = str("auth_invalid")
	invalid.ErrorDetail = str("synthetic private provider text")
	invalid.Usage = usage.Normalize("openai", map[string]int64{"openai_output_tokens": 1, "openai_reasoning_tokens": 2}, false)
	invalid.Usage.ReasoningRelation = "subset_of_output"
	r.Complete(probe, invalid, 3600)
	require.Eventually(t, func() bool { return r.pending.Load() == 0 && r.Accepting() }, 2*time.Second, 10*time.Millisecond)
	var raw []byte
	var reason string
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT terminal,reason FROM motai.probe_completion_quarantine WHERE attempt_id=$1`, probe.AttemptID).Scan(&raw, &reason))
	require.Equal(t, "reasoning_exceeds_output", reason)
	var stored Terminal
	require.NoError(t, json.Unmarshal(raw, &stored))
	expected := invalid
	expected.ErrorDetail = nil
	require.Equal(t, expected, stored, "quarantine retains the actual result and numeric observations")
	require.NotContains(t, string(raw), "error_detail")
	require.NotContains(t, string(raw), "synthetic private provider text")
	var count int64
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.channel_health WHERE pool_id=$1`, probe.PoolID).Scan(&count))
	require.Zero(t, count, "health changes made before validation must be rolled back")
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempt_events WHERE attempt_id=$1`, probe.AttemptID).Scan(&count))
	require.Zero(t, count)
	var unfinished bool
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT terminal IS NULL AND terminal_seq IS NULL FROM motai.attempts WHERE attempt_id=$1`, probe.AttemptID).Scan(&unfinished))
	require.True(t, unfinished, "quarantine must not fabricate a canonical terminal")
	status := r.Status(ctx)
	require.Equal(t, beforeQuarantined+1, status["probe_completion_quarantined"])
	require.NotContains(t, status["referenced_gens"], probe.Gen)
	require.NoError(t, r.commit(ctx, completion{probe, invalid, 3600}))
	require.NoError(t, r.commit(ctx, completion{probe, ledgerSuccess(probe), 3600}), "a quarantined probe must not later create a canonical event")

	_, model, err := r.Admit(ctx, candidates, intent(), "primary")
	require.NoError(t, err, "a malformed probe must not block subsequent business traffic")
	badModel := invalid
	badModel.AttemptID = model.AttemptID
	require.EqualError(t, r.commit(ctx, completion{model, badModel, 3600}), "reasoning_exceeds_output")
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.probe_completion_quarantine WHERE attempt_id=$1`, model.AttemptID).Scan(&count))
	require.Zero(t, count, "business completion validation failures must retain the original protection")
	r.Complete(model, ledgerSuccess(model), 3600)
	require.Eventually(t, func() bool { return r.pending.Load() == 0 }, 2*time.Second, 10*time.Millisecond)
	var afterSeq int64
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&afterSeq))
	require.Equal(t, beforeSeq+1, afterSeq, "only the normal business completion creates an event")

	blocked := intent()
	blocked.Kind = "probe"
	_, blocked, err = r.Admit(ctx, candidates, blocked, "primary")
	require.NoError(t, err)
	blockedTerminal := invalid
	blockedTerminal.AttemptID = blocked.AttemptID
	blocker, err := r.Store.Runtime.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer blocker.Rollback()
	require.NoError(t, blocker.QueryRowContext(ctx, `SELECT 1 FROM motai.attempts WHERE attempt_id=$1 FOR UPDATE`, blocked.AttemptID).Scan(&count))
	blockedCtx, stop := context.WithTimeout(ctx, 100*time.Millisecond)
	err = r.quarantineProbe(blockedCtx, completion{blocked, blockedTerminal, 3600}, reason)
	stop()
	require.Error(t, err, "quarantine storage errors must propagate instead of releasing the result")
	require.NoError(t, blocker.Rollback())
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.probe_completion_quarantine WHERE attempt_id=$1`, blocked.AttemptID).Scan(&count))
	require.Zero(t, count)
	longReason := "schema:" + strings.Repeat("x", 180)
	require.NoError(t, r.quarantineProbe(ctx, completion{blocked, blockedTerminal, 3600}, longReason))
	var storedReason string
	require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT reason FROM motai.probe_completion_quarantine WHERE attempt_id=$1`, blocked.AttemptID).Scan(&storedReason))
	require.Equal(t, longReason, storedReason, "the quarantine must accept the full bounded schema diagnostic")
	r.Complete(blocked, blockedTerminal, 3600)
	require.Eventually(t, func() bool { return r.pending.Load() == 0 && r.Accepting() }, 2*time.Second, 10*time.Millisecond)

	r.Close()
	require.ErrorIs(t, r.quarantineProbe(ctx, completion{probe, invalid, 3600}, reason), errRuntimeFenced)
	restarted, err := New(ctx, r.Store, r.Validator, r.key, 8)
	require.NoError(t, err)
	t.Cleanup(restarted.Close)
	require.True(t, restarted.Accepting())
	require.NoError(t, restarted.Store.Runtime.QueryRowContext(ctx, `SELECT terminal IS NULL FROM motai.attempts WHERE attempt_id=$1`, probe.AttemptID).Scan(&unfinished))
	require.True(t, unfinished, "startup must skip quarantined probes rather than rewrite them as interrupted")
	require.NoError(t, restarted.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempt_events WHERE attempt_id IN ($1,$2)`, probe.AttemptID, blocked.AttemptID).Scan(&count))
	require.Zero(t, count)
	require.NoError(t, restarted.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.probe_completion_quarantine`).Scan(&count))
	require.Equal(t, beforeQuarantined+2, count)
}
