package attempt

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
)

type ProbeContextKey struct{}
type Probe struct {
	ChannelID string
	PoolID    string
	ModelID   string
	Protocol  string
	RequestID string
	AttemptID string
	Manual    bool
}

func (r *Runtime) ClaimProbe(ctx context.Context, id string, request []byte, response map[string]any) (map[string]any, bool, error) {
	tx, err := r.Store.Runtime.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return nil, false, err
	}
	if err = r.guardLease(ctx, tx); err != nil {
		return nil, false, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, id); err != nil {
		return nil, false, err
	}
	var oldRequest, oldResponse []byte
	err = tx.QueryRowContext(ctx, `SELECT request,response FROM motai.probe_runs WHERE client_run_id=$1`, id).Scan(&oldRequest, &oldResponse)
	if err == nil {
		var a, b any
		if json.Unmarshal(oldRequest, &a) != nil || json.Unmarshal(request, &b) != nil || string(mustJSON(a)) != string(mustJSON(b)) {
			return nil, false, errors.New("operation_conflict")
		}
		var value map[string]any
		err = json.Unmarshal(oldResponse, &value)
		return value, false, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	raw, err := json.Marshal(response)
	if err != nil {
		return nil, false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO motai.probe_runs(client_run_id,request,response,boot_id) VALUES($1,$2,$3,$4)`, id, request, raw, r.BootID); err != nil {
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return response, true, nil
}
func (r *Runtime) FinishProbe(ctx context.Context, id string) {
	tx, err := r.Store.Runtime.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer tx.Rollback()
	if err = r.guardLease(ctx, tx); err != nil {
		return
	}
	if _, err = tx.ExecContext(ctx, `UPDATE motai.probe_runs SET response=jsonb_set(response,'{state}','"completed"'::jsonb) WHERE client_run_id=$1 AND boot_id=$2`, id, r.BootID); err != nil {
		return
	}
	_ = tx.Commit()
}
