package attempt

import (
	"context"
	"encoding/json"
	"log"
)

func (r *Runtime) quarantineProbe(ctx context.Context, item completion, reason string) error {
	if item.intent.Kind != "probe" {
		return ErrInvalidIntent
	}
	value := item.terminal
	value.ErrorDetail = nil
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	tx, err := r.Store.Runtime.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return err
	}
	if err = r.guardLease(ctx, tx); err != nil {
		return err
	}
	var kind string
	var completed bool
	if err = tx.QueryRowContext(ctx, `SELECT kind,terminal IS NOT NULL FROM motai.attempts WHERE attempt_id=$1 FOR UPDATE`, item.intent.AttemptID).Scan(&kind, &completed); err != nil {
		return err
	}
	if kind != "probe" {
		return ErrInvalidIntent
	}
	if completed {
		return tx.Commit()
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO motai.probe_completion_quarantine(attempt_id,terminal,reason) VALUES($1,$2,$3) ON CONFLICT(attempt_id) DO NOTHING`, item.intent.AttemptID, data, reason)
	if err != nil {
		return err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if inserted > 0 {
		log.Printf("motai probe_completion_quarantined attempt_id=%s validation_reason=%s", item.intent.AttemptID, reason)
	}
	return nil
}
