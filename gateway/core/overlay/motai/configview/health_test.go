package configview

import (
	"context"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/store"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestPostgresHealthResetOptimismIdempotencyAndManualDisable(t *testing.T) {
	if os.Getenv("MOTAI_RUNTIME_DSN") == "" {
		t.Skip("requires isolated synthetic PostgreSQL")
	}
	ctx := context.Background()
	db, err := store.Open(os.Getenv("MOTAI_RUNTIME_DSN"), os.Getenv("MOTAI_ACTIVATOR_DSN"))
	require.NoError(t, err)
	defer db.Close()
	pool, ref, version := "test-reset-"+uuid.NewString(), "synthetic-ref", "1"
	gen := strconv.FormatInt(time.Now().UnixNano(), 10)
	_, err = db.Activator.ExecContext(ctx, `INSERT INTO motai.config_generations(gen,manifest_file,manifest_sha256) VALUES($1,'synthetic.json',repeat('a',64));`, gen)
	require.NoError(t, err)
	_, err = db.Activator.ExecContext(ctx, `UPDATE motai.gateway_state SET committed_gen=$1 WHERE singleton=1`, gen)
	require.NoError(t, err)
	manager := &Manager{Store: db}
	manager.current.Store(&View{Config: Config{Gen: gen, Channels: []Channel{{ID: "disabled", PoolID: pool, Enabled: false, CredentialRef: &ref, CredentialVersion: &version}, {ID: "no-credential", PoolID: pool}}}})
	health, err := manager.ChannelHealth(ctx)
	require.NoError(t, err)
	require.Equal(t, gen, health["gen"])
	rows := health["channels"].([]map[string]any)
	require.Len(t, rows, 2)
	require.Equal(t, "0", rows[0]["state_version"])
	require.Nil(t, rows[0]["observed_at"])
	_, err = db.Runtime.ExecContext(ctx, `INSERT INTO motai.channel_health(pool_id,channel_id,credential_ref,credential_version,state,revision,observed_at) VALUES($1,'disabled',$2,$3,'auth_invalid',1,now())`, pool, ref, version)
	require.NoError(t, err)
	request := HealthResetRequest{FormatVersion: 1, OperationID: uuid.NewString(), ExpectedGen: gen, ExpectedCredentialVersion: version, ExpectedStateVersion: "0"}
	_, err = manager.ResetChannelHealth(ctx, "disabled", request)
	require.EqualError(t, err, "channel_state_conflict")
	request.ExpectedStateVersion = "1"
	response, err := manager.ResetChannelHealth(ctx, "disabled", request)
	require.NoError(t, err)
	require.Equal(t, true, response["changed"])
	require.Equal(t, "2", response["state_version"])
	replay, err := manager.ResetChannelHealth(ctx, "disabled", request)
	require.NoError(t, err)
	expectedJSON, err := common.Marshal(response)
	require.NoError(t, err)
	replayedJSON, err := common.Marshal(replay)
	require.NoError(t, err)
	require.JSONEq(t, string(expectedJSON), string(replayedJSON))
	request.ExpectedStateVersion = "2"
	_, err = manager.ResetChannelHealth(ctx, "disabled", request)
	require.EqualError(t, err, "operation_conflict")
	request.OperationID = uuid.NewString()
	request.ExpectedCredentialVersion = "2"
	_, err = manager.ResetChannelHealth(ctx, "disabled", request)
	require.EqualError(t, err, "channel_state_conflict")
	request.ExpectedCredentialVersion = version
	request.ExpectedGen = "1"
	_, err = manager.ResetChannelHealth(ctx, "disabled", request)
	require.EqualError(t, err, "stale_base_generation")
	request.ExpectedGen = gen
	response, err = manager.ResetChannelHealth(ctx, "disabled", request)
	require.NoError(t, err)
	require.Equal(t, false, response["changed"])
	require.Equal(t, "2", response["state_version"])
	require.False(t, manager.Snapshot().Config.Channels[0].Enabled)
	_, err = db.Runtime.ExecContext(ctx, `UPDATE motai.channel_health SET state='exhausted',revision=revision+1,observed_at=now() WHERE pool_id=$1`, pool)
	require.NoError(t, err)
	request.OperationID = uuid.NewString()
	_, err = manager.ResetChannelHealth(ctx, "disabled", request)
	require.EqualError(t, err, "channel_state_conflict")
	health, err = manager.ChannelHealth(ctx)
	require.NoError(t, err)
	rows = health["channels"].([]map[string]any)
	require.Equal(t, "exhausted", rows[0]["state"])
	require.Equal(t, "3", rows[0]["state_version"])
	require.Equal(t, time.UTC, rows[0]["observed_at"].(*time.Time).Location())
}

func TestPostgresMultiPoolHealthResetIsolation(t *testing.T) {
	if os.Getenv("MOTAI_RUNTIME_DSN") == "" {
		t.Skip("requires isolated synthetic PostgreSQL")
	}
	ctx := context.Background()
	db, err := store.Open(os.Getenv("MOTAI_RUNTIME_DSN"), os.Getenv("MOTAI_ACTIVATOR_DSN"))
	require.NoError(t, err)
	defer db.Close()
	poolA, poolB, ref, version := "multi-a-"+uuid.NewString(), "multi-b-"+uuid.NewString(), "synthetic-shared-ref", "1"
	gen := strconv.FormatInt(time.Now().UnixNano(), 10)
	_, err = db.Activator.ExecContext(ctx, `INSERT INTO motai.config_generations(gen,manifest_file,manifest_sha256) VALUES($1,'synthetic.json',repeat('a',64))`, gen)
	require.NoError(t, err)
	_, err = db.Activator.ExecContext(ctx, `UPDATE motai.gateway_state SET committed_gen=$1 WHERE singleton=1`, gen)
	require.NoError(t, err)
	manager := &Manager{Store: db}
	manager.current.Store(&View{Config: Config{Gen: gen, Channels: []Channel{{ID: "shared", PoolID: poolA, PoolIDs: []string{poolA, poolB}, CredentialRef: &ref, CredentialVersion: &version}}}})
	for _, pool := range []string{poolA, poolB} {
		_, err = db.Runtime.ExecContext(ctx, `INSERT INTO motai.channel_health(pool_id,channel_id,credential_ref,credential_version,state,revision,observed_at) VALUES($1,'shared',$2,$3,'exhausted',1,now())`, pool, ref, version)
		require.NoError(t, err)
	}
	request := HealthResetRequest{FormatVersion: 1, OperationID: uuid.NewString(), ExpectedGen: gen, ExpectedCredentialVersion: version, ExpectedStateVersion: "1"}
	_, err = manager.ResetChannelHealth(ctx, "shared", request)
	require.EqualError(t, err, "invalid_contract")
	request.PoolID = poolB
	response, err := manager.ResetChannelHealth(ctx, "shared", request)
	require.NoError(t, err)
	require.Equal(t, poolB, response["pool_id"])
	health, err := manager.ChannelHealth(ctx)
	require.NoError(t, err)
	rows := health["channels"].([]map[string]any)
	require.Len(t, rows, 2)
	require.Equal(t, poolA, rows[0]["pool_id"])
	require.Equal(t, "exhausted", rows[0]["state"])
	require.Equal(t, "1", rows[0]["state_version"])
	require.Equal(t, poolB, rows[1]["pool_id"])
	require.Equal(t, "available", rows[1]["state"])
	require.Equal(t, "2", rows[1]["state_version"])
	request.PoolID = poolA
	_, err = manager.ResetChannelHealth(ctx, "shared", request)
	require.EqualError(t, err, "operation_conflict")
}
