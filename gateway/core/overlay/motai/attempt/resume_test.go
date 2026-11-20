package attempt

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPostgresCompletionRecoveryKeepsAdmissionClosedUntilDurable(t *testing.T) {
	for _, state := range []string{"held", "worker-and-queued"} {
		t.Run(state, func(t *testing.T) {
			r, candidates, intent := ledgerTestRuntimeCapacity(t, 64)
			ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
			defer cancel()
			count := 1
			if state == "worker-and-queued" {
				count = 3
			}
			admitted := make([]Intent, count)
			for index := range admitted {
				_, value, err := r.Admit(ctx, candidates, intent(), "")
				require.NoError(t, err)
				admitted[index] = value
			}
			blocker, err := r.Store.Runtime.BeginTx(ctx, nil)
			require.NoError(t, err)
			defer blocker.Rollback()
			var seq int64
			require.NoError(t, blocker.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1 FOR UPDATE`).Scan(&seq))
			terminals := make([]Terminal, count)
			for index, value := range admitted {
				terminal := ledgerSuccess(value)
				if index == 0 {
					status := 503
					terminal.UpstreamStatus = &status
					terminal.RequestOutcome = "failed"
					terminal.AttemptOutcome = "upstream_rejected"
					terminal.ErrorClass = str("upstream_5xx")
					terminal.ErrorDetail = str("synthetic retained failure")
				}
				terminals[index] = terminal
				r.Complete(value, terminal, 3600)
			}
			if state == "held" {
				// All three bounded writes time out while the dedicated lease
				// heartbeat remains healthy; the actual result stays retained.
				require.Eventually(t, func() bool {
					r.mu.Lock()
					defer r.mu.Unlock()
					return len(r.held) == 1
				}, 18*time.Second, 25*time.Millisecond)
			} else {
				require.Eventually(t, r.completionOverdue, 6*time.Second, 20*time.Millisecond)
			}
			require.False(t, r.fenced.Load(), "only ledger writes are blocked, not the lease")
			if state == "held" {
				r.SetAccepting(false)
			} else {
				r.SetAccepting(true)
			}
			require.True(t, r.failed.Load(), "resume must retain the ledger failure until every result is durable")
			require.False(t, r.Accepting())
			require.EqualError(t, r.reserve(), "gateway_log_unavailable")
			require.NoError(t, blocker.Commit())
			require.Eventually(t, func() bool { return r.pending.Load() == 0 && !r.failed.Load() }, 8*time.Second, 20*time.Millisecond)
			if state == "held" {
				require.False(t, r.Accepting(), "automatic ledger recovery must preserve an explicit drain")
				require.ErrorIs(t, r.reserve(), ErrDraining)
				r.SetAccepting(true)
			}
			require.True(t, r.Accepting())
			for index, value := range admitted {
				var raw []byte
				require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT terminal FROM motai.attempts WHERE attempt_id=$1`, value.AttemptID).Scan(&raw))
				var actual Terminal
				require.NoError(t, json.Unmarshal(raw, &actual))
				require.Equal(t, terminals[index].AttemptOutcome, actual.AttemptOutcome)
				require.Equal(t, terminals[index].ErrorDetail, actual.ErrorDetail)
				require.NoError(t, r.commit(ctx, completion{value, terminals[index], 3600}))
			}
			_, value, err := r.Admit(ctx, candidates, intent(), "")
			require.NoError(t, err)
			r.Complete(value, ledgerSuccess(value), 3600)
			require.Eventually(t, func() bool { return r.pending.Load() == 0 }, time.Second, 10*time.Millisecond)
			var records, events int64
			require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*),count(terminal) FROM motai.attempts WHERE pool_id=$1`, value.PoolID).Scan(&records, &events))
			require.EqualValues(t, count+1, records)
			require.Equal(t, records, events, "all retained results must survive automatic recovery")
			var finalSeq int64
			require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1`).Scan(&finalSeq))
			require.Equal(t, seq+int64(count)+1, finalSeq, "automatic retries and duplicate completions must not duplicate events")
		})
	}
}
