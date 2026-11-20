package attempt

import (
	"context"
	"database/sql"
	"time"

	"github.com/QuantumNous/new-api/motai/store"
)

// Channel state is keyed by credential version; only current-epoch terminals may update it.
// The caller holds the current pool epoch lock and the terminal event lock.
func applyChannelHealth(ctx context.Context, tx *sql.Tx, intent Intent, value *Terminal) error {
	if value.AttemptOutcome != "funds_exhausted" && value.AttemptOutcome != "auth_invalid" && !(intent.Kind == "probe" && value.AttemptOutcome == "succeeded") {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, store.ChannelHealthLock(intent.PoolID, intent.ChannelID, intent.CredentialRef, intent.CredentialVersion)); err != nil {
		return err
	}
	if value.AttemptOutcome == "funds_exhausted" || value.AttemptOutcome == "auth_invalid" {
		state := value.AttemptOutcome
		if state == "funds_exhausted" {
			state = "exhausted"
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO motai.channel_health(pool_id,channel_id,credential_ref,credential_version,state,revision,observed_at) VALUES($1,$2,$3,$4,$5,1,$6)
 ON CONFLICT(pool_id,channel_id,credential_ref,credential_version) DO UPDATE SET state=CASE WHEN motai.channel_health.state='auth_invalid' THEN 'auth_invalid' ELSE excluded.state END,revision=motai.channel_health.revision+1,observed_at=excluded.observed_at RETURNING state`, intent.PoolID, intent.ChannelID, intent.CredentialRef, intent.CredentialVersion, state, time.Now().UTC()).Scan(&state); err != nil {
			return err
		}
		value.ChannelEffect = state
		if intent.PoolID == "claude" {
			return nil
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM motai.affinity_bindings WHERE pool_id=$1 AND channel_id=$2 AND credential_version=$3`, intent.PoolID, intent.ChannelID, intent.CredentialVersion)
		return err
	}
	if intent.Kind == "probe" && value.AttemptOutcome == "succeeded" {
		// A probe already in flight when exhaustion was observed is not recovery
		// evidence. Credential failures require replacement or explicit reset.
		result, err := tx.ExecContext(ctx, `UPDATE motai.channel_health SET state='available',revision=revision+1,observed_at=$5 WHERE pool_id=$1 AND channel_id=$2 AND credential_ref=$3 AND credential_version=$4 AND state='exhausted' AND observed_at<=$6`, intent.PoolID, intent.ChannelID, intent.CredentialRef, intent.CredentialVersion, time.Now().UTC(), intent.StartedAt)
		if err != nil {
			return err
		}
		if count, err := result.RowsAffected(); err != nil {
			return err
		} else if count > 0 {
			value.ChannelEffect = "success_reset"
		}
	}
	return nil
}
