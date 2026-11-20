package attempt

import (
	"context"
	"database/sql"
	"errors"
	"log"
	"time"
)

var errRuntimeFenced = errors.New("runtime_lease_lost")

const leaseLockPredicate = `locktype='advisory' AND granted AND mode='ExclusiveLock' AND objsubid=1
 AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
 AND classid=(653914155008831::bigint >> 32)::oid
 AND objid=(653914155008831::bigint & 4294967295::bigint)::oid`

// The session lock elects an owner; the durable row serializes its replacement
// with every write transaction, including transactions on pooled connections.
func (r *Runtime) claimLease(ctx context.Context) error {
	tx, err := r.lease.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO motai.runtime_lease(singleton,boot_id,lease_pid) VALUES(1,$1,pg_backend_pid())
 ON CONFLICT(singleton) DO UPDATE SET boot_id=excluded.boot_id,lease_pid=excluded.lease_pid`, r.BootID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Runtime) guardLease(ctx context.Context, tx *sql.Tx) error {
	if r.fenced.Load() {
		return errRuntimeFenced
	}
	var active bool
	err := tx.QueryRowContext(ctx, `SELECT l.boot_id::text=$1 AND EXISTS(SELECT 1 FROM pg_locks WHERE pid=l.lease_pid AND `+leaseLockPredicate+`)
 FROM motai.runtime_lease l WHERE singleton=1 FOR SHARE OF l`, r.BootID).Scan(&active)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !active) {
		r.fence("lease_guard", errRuntimeFenced)
		return errRuntimeFenced
	}
	if err != nil {
		return err
	}
	if r.fenced.Load() {
		return errRuntimeFenced
	}
	return nil
}

func (r *Runtime) fence(source string, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.fenced.Swap(true) {
		class, state := errorDiagnostic(err)
		log.Printf("motai runtime_fenced boot_id=%s source=%s error_class=%s sqlstate=%s completion_pending=%d", r.BootID, source, class, state, r.pending.Load())
	}
	r.draining.Store(true)
	r.failed.Store(true)
}

func (r *Runtime) monitorLease() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-ticker.C:
			r.completionOverdue()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			r.leaseMu.Lock()
			var active bool
			err := r.lease.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND `+leaseLockPredicate+`)`).Scan(&active)
			r.leaseMu.Unlock()
			cancel()
			if err != nil || !active {
				if err == nil {
					err = errRuntimeFenced
				}
				r.fence("lease_monitor", err)
				return
			}
		}
	}
}

func (r *Runtime) completionOverdue() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, since := range r.waiting {
		if time.Since(since) > 5*time.Second {
			if r.failed.CompareAndSwap(false, true) {
				log.Printf("motai completion_wait_exceeded attempt_id=%s wait_ms=%d completion_pending=%d", id, time.Since(since).Milliseconds(), r.pending.Load())
			}
			return true
		}
	}
	return false
}
