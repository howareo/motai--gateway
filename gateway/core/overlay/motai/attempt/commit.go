package attempt

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/QuantumNous/new-api/motai/contract"
)

// The event counter lock is held until COMMIT: seq follows visible commit order.
func (r *Runtime) commit(ctx context.Context, item completion) (err error) {
	stage := "begin"
	defer func() {
		if err != nil {
			class, state := errorDiagnostic(err)
			reason := "none"
			if stage == "validate_record" {
				class = "invalid_contract"
				reason = contract.ValidationReason(err)
			}
			log.Printf("motai completion_commit_failed attempt_id=%s stage=%s error_class=%s sqlstate=%s validation_reason=%s", item.intent.AttemptID, stage, class, state, reason)
		}
	}()
	tx, err := r.Store.Runtime.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stage = "set_durability"
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return err
	}
	stage = "lease_guard"
	if err = r.guardLease(ctx, tx); err != nil {
		return err
	}
	var seq int64
	stage = "lock_event_sequence"
	if err = tx.QueryRowContext(ctx, `SELECT seq FROM motai.event_seq WHERE singleton=1 FOR UPDATE`).Scan(&seq); err != nil {
		return err
	}
	var terminal []byte
	var quarantined bool
	stage = "lock_attempt"
	if err = tx.QueryRowContext(ctx, `SELECT a.terminal,EXISTS(SELECT 1 FROM motai.probe_completion_quarantine q WHERE q.attempt_id=a.attempt_id) FROM motai.attempts a WHERE a.attempt_id=$1 FOR UPDATE OF a`, item.intent.AttemptID).Scan(&terminal, &quarantined); err != nil {
		return err
	}
	if terminal != nil || quarantined {
		stage = "commit_existing"
		return tx.Commit()
	}
	intent, value := item.intent, item.terminal
	var epoch string
	stage = "lock_pool_epoch"
	if err = tx.QueryRowContext(ctx, `SELECT motai.lock_pool_epoch($1)`, intent.PoolID).Scan(&epoch); err != nil {
		return err
	}
	if epoch == intent.PoolEpoch {
		stage = "apply_channel_health"
		if err = applyChannelHealth(ctx, tx, intent, &value); err != nil {
			return err
		}
	}
	if epoch == intent.PoolEpoch && intent.Kind == "model" && intent.PoolID != "claude" {
		stage = "apply_affinity"
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, intent.Affinity.Digest); err != nil {
			return err
		}
		now := time.Now().UTC()
		if value.AttemptOutcome == "succeeded" {
			value.ChannelEffect = "success_reset"
			if _, err = tx.ExecContext(ctx, `DELETE FROM motai.failure_windows WHERE scope_key=$1 AND channel_id=$2 AND credential_version=$3`, intent.Affinity.Digest, intent.ChannelID, intent.CredentialVersion); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `UPDATE motai.affinity_bindings SET expires_at=$4 WHERE scope_key=$1 AND channel_id=$2 AND credential_version=$3`, intent.Affinity.Digest, intent.ChannelID, intent.CredentialVersion, now.Add(time.Duration(item.ttl)*time.Second)); err != nil {
				return err
			}
		} else if value.AttemptOutcome == "rate_limited" && value.RetryAfterUntil != nil {
			value.ChannelEffect = "cooldown"
			if _, err = tx.ExecContext(ctx, `INSERT INTO motai.channel_cooldowns(cooldown_key,until_at,reason,observed_at) VALUES($1,$2,'retry_after',$3) ON CONFLICT(cooldown_key) DO UPDATE SET until_at=GREATEST(motai.channel_cooldowns.until_at,excluded.until_at),reason='retry_after',observed_at=excluded.observed_at`, cooldownKey(intent), *value.RetryAfterUntil, now); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, `DELETE FROM motai.affinity_bindings WHERE scope_key=$1 AND channel_id=$2 AND credential_version=$3`, intent.Affinity.Digest, intent.ChannelID, intent.CredentialVersion); err != nil {
				return err
			}
		} else if value.ErrorClass != nil && (*value.ErrorClass == "upstream_5xx" || *value.ErrorClass == "upstream_timeout" || *value.ErrorClass == "connect_failed" || *value.ErrorClass == "rate_limited") {
			var failures int
			if err = tx.QueryRowContext(ctx, `INSERT INTO motai.failure_windows(scope_key,channel_id,credential_version,window_started,failures) VALUES($1,$2,$3,$4,1)
    ON CONFLICT(scope_key,channel_id,credential_version) DO UPDATE SET window_started=CASE WHEN motai.failure_windows.window_started+interval '300 seconds'<=$4 THEN $4 ELSE motai.failure_windows.window_started END,
    failures=CASE WHEN motai.failure_windows.window_started+interval '300 seconds'<=$4 THEN 1 ELSE motai.failure_windows.failures+1 END RETURNING failures`, intent.Affinity.Digest, intent.ChannelID, intent.CredentialVersion, now).Scan(&failures); err != nil {
				return err
			}
			value.ChannelEffect = "failure_counted"
			var recovering bool
			if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM motai.channel_cooldowns WHERE cooldown_key=$1 AND reason='ordinary')`, cooldownKey(intent)).Scan(&recovering); err != nil {
				return err
			}
			if failures >= 3 || recovering {
				value.ChannelEffect = "cooldown"
				if _, err = tx.ExecContext(ctx, `INSERT INTO motai.channel_cooldowns(cooldown_key,until_at,reason,observed_at) VALUES($1,$2,'ordinary',$3) ON CONFLICT(cooldown_key) DO UPDATE SET until_at=GREATEST(motai.channel_cooldowns.until_at,excluded.until_at),reason='ordinary',observed_at=excluded.observed_at`, cooldownKey(intent), now.Add(60*time.Second), now); err != nil {
					return err
				}
				if _, err = tx.ExecContext(ctx, `DELETE FROM motai.affinity_bindings WHERE scope_key=$1 AND channel_id=$2 AND credential_version=$3`, intent.Affinity.Digest, intent.ChannelID, intent.CredentialVersion); err != nil {
					return err
				}
			}
		}
	}
	if epoch == intent.PoolEpoch && intent.PoolID != "claude" {
		if value.AttemptOutcome == "succeeded" {
			// An older in-flight success does not prove recovery from a newer fault.
			result, deleteErr := tx.ExecContext(ctx, `DELETE FROM motai.channel_cooldowns WHERE cooldown_key=$1 AND observed_at<=$2`, cooldownKey(intent), intent.StartedAt)
			if deleteErr != nil {
				return deleteErr
			}
			if count, countErr := result.RowsAffected(); countErr != nil {
				return countErr
			} else if count > 0 {
				value.ChannelEffect = "success_reset"
			}
		} else if intent.Kind == "probe" && value.ErrorClass != nil && (*value.ErrorClass == "upstream_5xx" || *value.ErrorClass == "upstream_timeout" || *value.ErrorClass == "connect_failed" || *value.ErrorClass == "rate_limited") {
			now := time.Now().UTC()
			if _, err = tx.ExecContext(ctx, `UPDATE motai.channel_cooldowns SET until_at=GREATEST(until_at,$2),observed_at=$3 WHERE cooldown_key=$1 AND reason='ordinary' AND observed_at<=$4`, cooldownKey(intent), now.Add(60*time.Second), now, intent.StartedAt); err != nil {
				return err
			}
		}
	}
	stage = "encode_terminal"
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	stage = "validate_record"
	if err = r.Validator.ValidateRecord("attempt", mustJSON(Record{FormatVersion: 1, Intent: intent, Terminal: value}), false); err != nil {
		if intent.Kind == "probe" {
			reason := contract.ValidationReason(err)
			stage = "rollback_invalid_probe"
			if err = tx.Rollback(); err != nil {
				return err
			}
			stage = "quarantine_probe"
			return r.quarantineProbe(ctx, item, reason)
		}
		return err
	}
	stage = "write_terminal"
	if _, err = tx.ExecContext(ctx, `UPDATE motai.attempts SET terminal=$2,terminal_seq=$3 WHERE attempt_id=$1 AND terminal IS NULL`, intent.AttemptID, data, seq+1); err != nil {
		return err
	}
	stage = "write_event_sequence"
	if _, err = tx.ExecContext(ctx, `UPDATE motai.event_seq SET seq=$1 WHERE singleton=1`, seq+1); err != nil {
		return err
	}
	stage = "write_event"
	if _, err = tx.ExecContext(ctx, `INSERT INTO motai.attempt_events(seq,attempt_id) VALUES($1,$2)`, seq+1, intent.AttemptID); err != nil {
		return err
	}
	stage = "commit"
	return tx.Commit()
}

func errorDiagnostic(err error) (string, string) {
	switch {
	case err == nil:
		return "none", ""
	case errors.Is(err, errRuntimeFenced):
		return "runtime_lease_lost", ""
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline_exceeded", ""
	case errors.Is(err, context.Canceled):
		return "context_canceled", ""
	case errors.Is(err, driver.ErrBadConn), errors.Is(err, sql.ErrConnDone):
		return "connection_unavailable", ""
	}
	var postgres interface{ SQLState() string }
	if errors.As(err, &postgres) {
		state := postgres.SQLState()
		if len(state) == 5 {
			for _, char := range state {
				if !(char >= '0' && char <= '9' || char >= 'A' && char <= 'Z') {
					return "storage_error", ""
				}
			}
			return "postgres", state
		}
	}
	return "storage_error", ""
}

func mustJSON(value any) []byte { data, _ := json.Marshal(value); return data }
