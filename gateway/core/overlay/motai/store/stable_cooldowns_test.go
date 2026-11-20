package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func stableCooldownTestKey(parts ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00") + "\x00"))
	return hex.EncodeToString(digest[:])
}

func TestPostgresStableCooldownMigration(t *testing.T) {
	// The existing lab owner connection can run migrations; runtime/activator
	// roles intentionally cannot insert schema migration markers.
	dsn := os.Getenv("MOTAI_OWNER_DSN")
	if dsn == "" {
		t.Skip("requires isolated synthetic PostgreSQL MOTAI_OWNER_DSN")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	require.NoError(t, err)
	defer db.Close()
	tx, err := db.BeginTx(ctx, nil)
	require.NoError(t, err)
	defer tx.Rollback()
	boot, pool := uuid.NewString(), "migration-"+uuid.NewString()
	_, err = tx.ExecContext(ctx, `INSERT INTO motai.pool_state(pool_id,epoch,routing_fingerprint)
	 VALUES($1,32,'synthetic-migration-test')`, pool)
	require.NoError(t, err)
	model, protocol, channel, version := "模型-闪光", "chat_completions", "channel-甲", "1"
	base := time.Date(2026, 11, 14, 13, 0, 0, 0, time.UTC)
	stable := stableCooldownTestKey(pool, model, protocol, channel, version)
	other := stableCooldownTestKey(pool, "other-model", protocol, channel, version)
	orphan := stableCooldownTestKey("unmatched-" + pool)
	keys := []string{stable, other, orphan}
	insertAttempt := func(epoch, name string) string {
		intent, marshalErr := json.Marshal(map[string]string{
			"pool_id": pool, "pool_epoch": epoch, "model_canonical": name,
			"protocol": protocol, "channel_id": channel, "credential_version": version,
		})
		require.NoError(t, marshalErr)
		_, execErr := tx.ExecContext(ctx, `INSERT INTO motai.attempts
		 (attempt_id,boot_id,intent,started_at,pool_id,channel_id,model_id,kind,stream)
		 VALUES($1,$2,$3,$4,$5,$6,$7,'model',false)`, uuid.NewString(), boot, intent, base, pool, channel, name)
		require.NoError(t, execErr)
		return stableCooldownTestKey(pool, epoch, name, protocol, channel, version)
	}
	insertCooldown := func(key string, until, observed int, reason string) {
		_, execErr := tx.ExecContext(ctx, `INSERT INTO motai.channel_cooldowns
		 (cooldown_key,until_at,reason,observed_at) VALUES($1,$2,$3,$4)`,
			key, base.Add(time.Duration(until)*time.Second), reason, base.Add(time.Duration(observed)*time.Second))
		require.NoError(t, execErr)
	}
	for _, row := range []struct {
		epoch           string
		until, observed int
		reason          string
	}{{"31", 60, 10, "ordinary"}, {"32", 120, 20, "retry_after"}, {"33", 900, 50, "ordinary"}} {
		key := insertAttempt(row.epoch, model)
		keys = append(keys, key)
		insertCooldown(key, row.until, row.observed, row.reason)
	}
	// Repeated attempts must not duplicate a mapped source or affect merging.
	insertAttempt("32", model)
	key := insertAttempt("32", "other-model")
	keys = append(keys, key)
	insertCooldown(key, 75, 40, "retry_after")
	insertCooldown(stable, 70, 15, "ordinary")
	insertCooldown(other, 150, 20, "ordinary")
	insertCooldown(orphan, 80, 50, "ordinary")
	data, err := migrations.ReadFile("migrations/010-stable-cooldowns.sql")
	require.NoError(t, err)
	type cooldown struct {
		Until    time.Time
		Observed time.Time
		Reason   string
	}
	snapshot := func() map[string]cooldown {
		result := map[string]cooldown{}
		for _, key := range keys {
			var row cooldown
			scanErr := tx.QueryRowContext(ctx, `SELECT until_at,observed_at,reason
			 FROM motai.channel_cooldowns WHERE cooldown_key=$1`, key).Scan(&row.Until, &row.Observed, &row.Reason)
			if scanErr == sql.ErrNoRows {
				continue
			}
			require.NoError(t, scanErr)
			result[key] = row
		}
		return result
	}
	before := snapshot()
	_, err = tx.ExecContext(ctx, string(data))
	require.NoError(t, err)
	first := snapshot()
	require.Len(t, first, len(keys), "all legacy keys remain usable by the previous binary")
	for _, oldKey := range keys[2:] {
		require.Equal(t, before[oldKey], first[oldKey], "legacy and unmatched rows are untouched")
	}
	require.Equal(t, "retry_after", first[stable].Reason, "reason follows the latest eligible fault")
	require.True(t, base.Add(120*time.Second).Equal(first[stable].Until))
	require.True(t, base.Add(20*time.Second).Equal(first[stable].Observed), "other epochs never revive historical faults")
	require.Equal(t, "retry_after", first[other].Reason)
	require.True(t, base.Add(150*time.Second).Equal(first[other].Until))
	require.True(t, base.Add(40*time.Second).Equal(first[other].Observed))
	require.Equal(t, "ordinary", first[orphan].Reason)
	require.True(t, base.Add(80*time.Second).Equal(first[orphan].Until))
	require.True(t, base.Add(50*time.Second).Equal(first[orphan].Observed))
	_, err = tx.ExecContext(ctx, string(data))
	require.NoError(t, err)
	require.Equal(t, first, snapshot(), "running the complete SQL again is idempotent")
	var count int
	require.NoError(t, tx.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts WHERE boot_id=$1`, boot).Scan(&count))
	require.Equal(t, 5, count, "attempt history is never deleted")
	require.NoError(t, tx.QueryRowContext(ctx, `SELECT epoch FROM motai.pool_state WHERE pool_id=$1`, pool).Scan(&count))
	require.Equal(t, 32, count, "the active pool epoch is unchanged")
	require.NoError(t, tx.QueryRowContext(ctx, `SELECT count(*) FROM motai.schema_migrations WHERE version=10`).Scan(&count))
	require.Equal(t, 1, count)
}
