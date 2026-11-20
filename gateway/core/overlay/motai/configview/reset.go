package configview

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"maps"
)

func (m *Manager) ResetAffinity(ctx context.Context, pool, id string) (map[string]any, error) {
	m.write.Lock()
	defer m.write.Unlock()
	current := m.current.Load()
	if current == nil {
		return nil, errors.New("gateway_not_ready")
	}
	if _, ok := current.Epochs[pool]; !ok {
		return nil, errors.New("pool_not_found")
	}
	tx, err := m.Store.Activator.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT singleton FROM motai.gateway_state WHERE singleton=1 FOR UPDATE`); err != nil {
		return nil, err
	}
	var oldKind string
	var oldPool *string
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT kind,pool_id,response FROM motai.operations WHERE operation_id=$1`, id).Scan(&oldKind, &oldPool, &raw)
	if err == nil {
		if oldKind != "affinity-reset" || oldPool == nil || *oldPool != pool {
			return nil, errors.New("operation_conflict")
		}
		var response map[string]any
		err = json.Unmarshal(raw, &response)
		return response, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var epoch string
	if err = tx.QueryRowContext(ctx, `UPDATE motai.pool_state SET epoch=epoch+1 WHERE pool_id=$1 RETURNING epoch::text`, pool).Scan(&epoch); err != nil {
		return nil, err
	}
	response := map[string]any{"format_version": 1, "operation_id": id, "pool_id": pool, "pool_epoch": epoch}
	raw, err = json.Marshal(response)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO motai.operations(operation_id,kind,pool_id,response) VALUES($1,'affinity-reset',$2,$3)`, id, pool, raw); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	next := *current
	next.Epochs = maps.Clone(current.Epochs)
	next.Epochs[pool] = epoch
	m.current.Store(&next)
	return response, nil
}
