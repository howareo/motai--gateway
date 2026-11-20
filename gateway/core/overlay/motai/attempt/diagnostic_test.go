package attempt

import (
	"context"
	"database/sql/driver"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type diagnosticPostgresError string

func (diagnosticPostgresError) Error() string      { panic("raw database error must not be inspected") }
func (e diagnosticPostgresError) SQLState() string { return string(e) }

func TestCompletionErrorDiagnosticsExcludeRawValues(t *testing.T) {
	for _, test := range []struct {
		name         string
		err          error
		class, state string
	}{
		{"none", nil, "none", ""},
		{"timeout", fmt.Errorf("sensitive value: %w", context.DeadlineExceeded), "deadline_exceeded", ""},
		{"canceled", context.Canceled, "context_canceled", ""},
		{"connection", driver.ErrBadConn, "connection_unavailable", ""},
		{"fenced", errRuntimeFenced, "runtime_lease_lost", ""},
		{"postgres", diagnosticPostgresError("23514"), "postgres", "23514"},
		{"unsafe-state", diagnosticPostgresError("42\nx!"), "storage_error", ""},
		{"unknown", errors.New("sensitive database values"), "storage_error", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			class, state := errorDiagnostic(test.err)
			require.Equal(t, test.class, class)
			require.Equal(t, test.state, state)
		})
	}
}

func TestRuntimeAcceptingPreservesLedgerAndLeaseGates(t *testing.T) {
	r := &Runtime{slots: make(chan struct{}, 1), sendSlots: make(chan struct{}, 1), waiting: make(map[string]time.Time)}
	r.slots <- struct{}{}
	r.sendSlots <- struct{}{}
	require.True(t, r.Accepting(), "capacity limits are ordinary backpressure")
	r.waiting["synthetic-attempt"] = time.Now().Add(-6 * time.Second)
	r.pending.Store(1)
	require.False(t, r.Accepting())
	r.SetAccepting(true)
	require.True(t, r.failed.Load(), "resume must not bypass an undurable result")
	require.False(t, r.Accepting())
	r.fence("test", errRuntimeFenced)
	r.SetAccepting(true)
	require.True(t, r.failed.Load())
	require.False(t, r.Accepting(), "a fenced runtime must never resume")
}
