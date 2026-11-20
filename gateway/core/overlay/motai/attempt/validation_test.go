package attempt

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestPostgresInvalidIntentDoesNotConsumeAdmission(t *testing.T) {
	r, candidates, makeIntent := ledgerTestRuntimeCapacity(t, 1)
	ctx := context.Background()
	for _, scenario := range []string{"effort-too-long", "effort-invalid-character", "effort-empty", "budget-over-safe-integer"} {
		t.Run(scenario, func(t *testing.T) {
			invalid := makeIntent()
			value, source := "", "request"
			switch scenario {
			case "effort-too-long":
				value = strings.Repeat("a", 65)
			case "effort-invalid-character":
				value = "high!"
			case "budget-over-safe-integer":
				budget := int64(9007199254740992)
				invalid.ThinkingBudget = &budget
			}
			if scenario != "budget-over-safe-integer" {
				invalid.Effort = Effort{Value: &value, Source: &source}
			}
			_, _, err := r.Admit(ctx, candidates, invalid, "")
			require.ErrorIs(t, err, ErrInvalidIntent)
			var records int
			require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE attempt_id=$1`, invalid.AttemptID).Scan(&records))
			require.Zero(t, records)
			require.False(t, r.failed.Load())
			require.Zero(t, r.inflight.Load())
			require.Zero(t, r.pending.Load())
			require.Empty(t, r.sendSlots)
			require.Empty(t, r.slots)
			_, valid, err := r.Admit(ctx, candidates, makeIntent(), "")
			require.NoError(t, err, "valid admission immediately follows rejected metadata")
			r.Complete(valid, ledgerSuccess(valid), 3600)
			require.Eventually(t, func() bool { return r.pending.Load() == 0 }, time.Second, 10*time.Millisecond)
		})
	}
}
