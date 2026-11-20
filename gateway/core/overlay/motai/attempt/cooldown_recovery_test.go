package attempt

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestPostgresCooldownRecovery(t *testing.T) {
	for _, scenario := range []string{"all-unavailable", "healthy-backup", "lower-priority", "stale-success", "epoch-and-credentials"} {
		t.Run(scenario, func(t *testing.T) {
			r, candidates, makeIntent := ledgerTestRuntime(t)
			ctx := context.Background()
			backup := candidates[0]
			backup.Channel.ID, backup.Channel.Name, backup.Channel.Priority = "backup", "backup", 9
			candidates = append(candidates, backup)
			admit := func(kind, target string) Intent {
				i := makeIntent()
				i.Kind = kind
				_, i, err := r.Admit(ctx, candidates, i, target)
				require.NoError(t, err)
				return i
			}
			finish := func(i Intent, success bool) {
				value := ledgerSuccess(i)
				if !success {
					status := 502
					value.RequestOutcome, value.AttemptOutcome = "failed", "upstream_rejected"
					value.UpstreamStatus, value.ErrorClass = &status, str("upstream_5xx")
				}
				require.NoError(t, r.commit(ctx, completion{i, value, 3600}))
				r.inflight.Add(-1)
				<-r.slots
				<-r.sendSlots
			}
			var oldModel, oldProbe Intent
			if scenario == "stale-success" {
				oldModel = admit("model", "primary")
				oldProbe = admit("probe", "primary")
			}
			var fault Intent
			for n := 0; n < 3; n++ {
				fault = admit("model", "primary")
				finish(fault, false)
			}
			expire := func() {
				_, err := r.Store.Runtime.ExecContext(ctx, `UPDATE motai.channel_cooldowns SET until_at=now()-interval '1 second' WHERE cooldown_key=$1`, cooldownKey(fault))
				require.NoError(t, err)
			}
			assertBackup := func(i Intent) {
				selected, i, err := r.Admit(ctx, candidates, i, "")
				require.NoError(t, err)
				require.Equal(t, "backup", selected.Channel.ID)
				finish(i, true)
			}
			assertBackup(makeIntent())
			switch scenario {
			case "all-unavailable", "healthy-backup":
				expire()
				if scenario == "all-unavailable" {
					candidates = candidates[:1]
				}
				type admission struct {
					intent Intent
					err    error
				}
				results := make(chan admission, 6)
				var wg sync.WaitGroup
				for n := 0; n < 6; n++ {
					wg.Add(1)
					go func() {
						defer wg.Done()
						i := makeIntent()
						i.Affinity = r.Scope(i.CallerID, i.PoolID, i.ModelCanonical, i.Protocol, i.PoolEpoch, uuid.NewString())
						_, i, err := r.Admit(ctx, candidates, i, "")
						results <- admission{i, err}
					}()
				}
				wg.Wait()
				close(results)
				var trial Intent
				trials, backups := 0, 0
				for result := range results {
					if result.err == nil {
						if result.intent.ChannelID == "primary" {
							trials++
							trial = result.intent
						} else {
							require.Equal(t, "healthy-backup", scenario)
							require.Equal(t, "backup", result.intent.ChannelID)
							backups++
							finish(result.intent, true)
						}
					} else {
						require.Equal(t, "all-unavailable", scenario)
						require.EqualError(t, result.err, "channel_temporarily_unavailable")
					}
				}
				require.Equal(t, 1, trials)
				if scenario == "healthy-backup" {
					require.Equal(t, 5, backups)
				}
				// A slow recovery request remains exclusive even after its retry timer.
				expire()
				if scenario == "healthy-backup" {
					assertBackup(makeIntent())
				} else {
					_, _, err := r.Admit(ctx, candidates, makeIntent(), "")
					require.EqualError(t, err, "channel_temporarily_unavailable")
				}
				finish(trial, false)
				var until time.Time
				require.NoError(t, r.Store.Runtime.QueryRowContext(ctx, `SELECT until_at FROM motai.channel_cooldowns WHERE cooldown_key=$1`, cooldownKey(fault)).Scan(&until))
				require.True(t, until.After(time.Now()))
				if scenario == "healthy-backup" {
					assertBackup(makeIntent())
				}
				expire()
				trial = admit("model", "")
				require.Equal(t, "primary", trial.ChannelID)
				finish(trial, true)
				restored := admit("model", "")
				require.Equal(t, "primary", restored.ChannelID)
				finish(restored, true)
			case "lower-priority":
				candidates[1].Channel.Priority = 11
				expire()
				assertBackup(makeIntent())
			case "stale-success":
				finish(oldModel, true)
				finish(oldProbe, true)
				assertBackup(makeIntent())
				for _, kind := range []string{"model", "protocol"} {
					i := makeIntent()
					i.Kind = "probe"
					if kind == "model" {
						i.ModelCanonical = "other-model"
					} else {
						i.Protocol = "responses"
					}
					_, i, err := r.Admit(ctx, candidates, i, "primary")
					require.NoError(t, err)
					finish(i, true)
					assertBackup(makeIntent())
				}
				finish(admit("probe", "primary"), false)
				assertBackup(makeIntent())
				finish(admit("probe", "primary"), true)
				restored := admit("model", "")
				require.Equal(t, "primary", restored.ChannelID)
				finish(restored, true)
			case "epoch-and-credentials":
				_, err := r.Store.Activator.ExecContext(ctx, `UPDATE motai.pool_state SET epoch=2 WHERE pool_id=$1`, fault.PoolID)
				require.NoError(t, err)
				fresh := makeIntent()
				fresh.PoolEpoch = "2"
				fresh.Affinity = r.Scope(fresh.CallerID, fresh.PoolID, fresh.ModelCanonical, fresh.Protocol, "2", "new-config")
				assertBackup(fresh)
				newVersion := "2"
				candidates[0].Channel.CredentialVersion = &newVersion
				fresh = makeIntent()
				fresh.PoolEpoch = "2"
				selected, i, err := r.Admit(ctx, candidates, fresh, "")
				require.NoError(t, err)
				require.Equal(t, "primary", selected.Channel.ID)
				finish(i, true)
			}
		})
	}
}
