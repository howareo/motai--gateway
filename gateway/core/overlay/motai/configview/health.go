package configview

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/store"
)

type HealthResetRequest struct {
	FormatVersion             int    `json:"format_version"`
	OperationID               string `json:"operation_id"`
	PoolID                    string `json:"pool_id,omitempty"`
	ExpectedGen               string `json:"expected_gen"`
	ExpectedCredentialVersion string `json:"expected_credential_version"`
	ExpectedStateVersion      string `json:"expected_state_version"`
}

func (m *Manager) ChannelHealth(ctx context.Context) (map[string]any, error) {
	m.write.Lock()
	defer m.write.Unlock()
	current := m.Snapshot()
	if current == nil {
		return nil, errors.New("gateway_not_ready")
	}
	channels := []map[string]any{}
	tx, err := m.Store.Runtime.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	for _, channel := range current.Config.Channels {
		for _, pool := range channel.Pools() {
			state, revision := "available", "0"
			var observed *time.Time
			if channel.CredentialRef != nil && channel.CredentialVersion != nil {
				err := tx.QueryRowContext(ctx, `SELECT state,revision::text,observed_at FROM motai.channel_health WHERE pool_id=$1 AND channel_id=$2 AND credential_ref=$3 AND credential_version=$4`, pool, channel.ID, *channel.CredentialRef, *channel.CredentialVersion).Scan(&state, &revision, &observed)
				if err != nil && !errors.Is(err, sql.ErrNoRows) {
					return nil, err
				}
			}
			if observed != nil {
				utc := observed.UTC()
				observed = &utc
			}
			channels = append(channels, map[string]any{"channel_id": channel.ID, "pool_id": pool, "credential_version": channel.CredentialVersion, "state": state, "state_version": revision, "observed_at": observed})
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return map[string]any{"format_version": 1, "gen": current.Config.Gen, "channels": channels}, nil
}

func (m *Manager) ResetChannelHealth(ctx context.Context, channelID string, request HealthResetRequest) (map[string]any, error) {
	m.write.Lock()
	defer m.write.Unlock()
	current := m.Snapshot()
	if current == nil {
		return nil, errors.New("gateway_not_ready")
	}
	encoded, err := common.Marshal(struct {
		ChannelID string             `json:"channel_id"`
		Request   HealthResetRequest `json:"request"`
	}{channelID, request})
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(encoded)
	requestHash := hex.EncodeToString(digest[:])
	tx, err := m.Store.Activator.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return nil, err
	}
	var committedGen *string
	if err = tx.QueryRowContext(ctx, `SELECT committed_gen FROM motai.gateway_state WHERE singleton=1 FOR UPDATE`).Scan(&committedGen); err != nil {
		return nil, err
	}
	var oldKind string
	var oldHash *string
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT kind,request_hash,response FROM motai.operations WHERE operation_id=$1`, request.OperationID).Scan(&oldKind, &oldHash, &raw)
	if err == nil {
		if oldKind != "health-reset" || oldHash == nil || *oldHash != requestHash {
			return nil, errors.New("operation_conflict")
		}
		var response map[string]any
		err = common.Unmarshal(raw, &response)
		return response, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if current.Config.Gen != request.ExpectedGen || committedGen == nil || *committedGen != request.ExpectedGen {
		return nil, errors.New("stale_base_generation")
	}
	var selected *Channel
	for index := range current.Config.Channels {
		if current.Config.Channels[index].ID == channelID {
			selected = &current.Config.Channels[index]
			break
		}
	}
	if selected == nil {
		return nil, errors.New("channel_not_found")
	}
	pool, err := selected.ResolvePool(request.PoolID)
	if err != nil {
		return nil, err
	}
	if selected.CredentialRef == nil || selected.CredentialVersion == nil || *selected.CredentialVersion != request.ExpectedCredentialVersion {
		return nil, errors.New("channel_state_conflict")
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, store.ChannelHealthLock(pool, selected.ID, *selected.CredentialRef, *selected.CredentialVersion)); err != nil {
		return nil, err
	}
	state, revision := "available", int64(0)
	err = tx.QueryRowContext(ctx, `SELECT state,revision FROM motai.channel_health WHERE pool_id=$1 AND channel_id=$2 AND credential_ref=$3 AND credential_version=$4 FOR UPDATE`, pool, selected.ID, *selected.CredentialRef, *selected.CredentialVersion).Scan(&state, &revision)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if strconv.FormatInt(revision, 10) != request.ExpectedStateVersion {
		return nil, errors.New("channel_state_conflict")
	}
	changed := state != "available"
	if changed {
		err = tx.QueryRowContext(ctx, `UPDATE motai.channel_health SET state='available',revision=revision+1,observed_at=$5 WHERE pool_id=$1 AND channel_id=$2 AND credential_ref=$3 AND credential_version=$4 RETURNING revision`, pool, selected.ID, *selected.CredentialRef, *selected.CredentialVersion, time.Now().UTC()).Scan(&revision)
		if err != nil {
			return nil, err
		}
	}
	response := map[string]any{"format_version": 1, "operation_id": request.OperationID, "channel_id": selected.ID, "pool_id": pool, "credential_version": *selected.CredentialVersion, "state": "available", "state_version": strconv.FormatInt(revision, 10), "changed": changed}
	raw, err = common.Marshal(response)
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO motai.operations(operation_id,kind,pool_id,request_hash,response) VALUES($1,'health-reset',$2,$3,$4)`, request.OperationID, pool, requestHash, raw); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return response, nil
}
