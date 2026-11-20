package attempt

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/QuantumNous/new-api/motai/configview"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/store"
	"github.com/QuantumNous/new-api/motai/usage"
	"github.com/google/uuid"
)

var (
	ErrDraining      = errors.New("gateway_draining")
	ErrBusy          = errors.New("gateway_busy")
	ErrInvalidIntent = errors.New("invalid_contract")
)

type ChannelUnavailableError struct {
	RetryAt time.Time
}

func (*ChannelUnavailableError) Error() string { return "channel_temporarily_unavailable" }

type completion struct {
	intent   Intent
	terminal Terminal
	ttl      int
}
type Runtime struct {
	Store     *store.Store
	Validator *contract.Validator
	BootID    string
	key       []byte
	slots     chan struct{}
	sendSlots chan struct{}
	queue     chan completion
	inflight  atomic.Int64
	pending   atomic.Int64
	draining  atomic.Bool
	failed    atomic.Bool
	mu        sync.Mutex
	held      []completion
	waiting   map[string]time.Time
	lease     *sql.Conn
	leaseMu   sync.Mutex
	fenced    atomic.Bool
	stop      chan struct{}
	closeOnce sync.Once
}

func New(ctx context.Context, db *store.Store, validator *contract.Validator, key []byte, capacity int) (*Runtime, error) {
	if capacity < 1 || capacity > 65536 {
		return nil, errors.New("invalid completion capacity")
	}
	var durable bool
	if err := db.Runtime.QueryRowContext(ctx, `SELECT current_setting('fsync')='on' AND current_setting('synchronous_commit') IN ('on','remote_apply','remote_write')`).Scan(&durable); err != nil || !durable {
		return nil, errors.New("durability unavailable")
	}
	r := &Runtime{Store: db, Validator: validator, BootID: uuid.NewString(), key: append([]byte(nil), key...), slots: make(chan struct{}, capacity), sendSlots: make(chan struct{}, min(64, capacity)), queue: make(chan completion, capacity), waiting: make(map[string]time.Time), stop: make(chan struct{})}
	lease, err := db.Runtime.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var locked bool
	if err = lease.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(653914155008831)`).Scan(&locked); err != nil || !locked {
		lease.Close()
		return nil, errors.New("runtime already active")
	}
	r.lease = lease
	if err := r.claimLease(ctx); err != nil {
		r.Close()
		return nil, err
	}
	if err := r.recover(ctx); err != nil {
		r.Close()
		return nil, err
	}
	go r.worker()
	go r.monitorLease()
	return r, nil
}
func (r *Runtime) Close() {
	r.closeOnce.Do(func() {
		r.fence("close", nil)
		close(r.stop)
		r.leaseMu.Lock()
		defer r.leaseMu.Unlock()
		if r.lease != nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, _ = r.lease.ExecContext(ctx, `SELECT pg_advisory_unlock(653914155008831)`)
			r.lease.Close()
		}
	})
}
func (r *Runtime) Scope(caller, pool, model, protocol, epoch, session string) Affinity {
	scope, value := "caller", caller
	if session != "" {
		scope, value = "session", session
	}
	mac := hmac.New(sha256.New, r.key)
	for _, part := range []string{"motai-affinity-v1", caller, pool, model, protocol, epoch, scope, value} {
		mac.Write([]byte(part))
		mac.Write([]byte{0})
	}
	return Affinity{scope, hex.EncodeToString(mac.Sum(nil))}
}
func cooldownKey(i Intent) string {
	mac := sha256.New()
	for _, part := range []string{i.PoolID, i.ModelCanonical, i.Protocol, i.ChannelID, i.CredentialVersion} {
		mac.Write([]byte(part))
		mac.Write([]byte{0})
	}
	return hex.EncodeToString(mac.Sum(nil))
}
func (r *Runtime) reserve() error {
	if r.completionOverdue() || r.failed.Load() || r.fenced.Load() {
		return errors.New("gateway_log_unavailable")
	}
	if r.draining.Load() {
		return ErrDraining
	}
	select {
	case r.sendSlots <- struct{}{}:
	default:
		return ErrBusy
	}
	select {
	case r.slots <- struct{}{}:
		return nil
	default:
		<-r.sendSlots
		return ErrBusy
	}
}
func (r *Runtime) Accepting() bool {
	return !r.completionOverdue() && !r.failed.Load() && !r.fenced.Load() && !r.draining.Load()
}
func (r *Runtime) Admit(ctx context.Context, candidates []configview.Selection, intent Intent, explicit string) (configview.Selection, Intent, error) {
	if err := r.reserve(); err != nil {
		return configview.Selection{}, intent, err
	}
	committed := false
	defer func() {
		if !committed {
			<-r.slots
			<-r.sendSlots
		}
	}()
	tx, err := r.Store.Runtime.BeginTx(ctx, nil)
	if err != nil {
		return configview.Selection{}, intent, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SET LOCAL synchronous_commit=on`); err != nil {
		return configview.Selection{}, intent, err
	}
	if err = r.guardLease(ctx, tx); err != nil {
		return configview.Selection{}, intent, err
	}
	var currentEpoch string
	if err = tx.QueryRowContext(ctx, `SELECT motai.lock_pool_epoch($1)`, intent.PoolID).Scan(&currentEpoch); err != nil {
		return configview.Selection{}, intent, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, intent.Affinity.Digest); err != nil {
		return configview.Selection{}, intent, err
	}
	var bound, version string
	var expires time.Time
	err = tx.QueryRowContext(ctx, `SELECT channel_id,credential_version,expires_at FROM motai.affinity_bindings WHERE scope_key=$1`, intent.Affinity.Digest).Scan(&bound, &version, &expires)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return configview.Selection{}, intent, err
	}
	now := time.Now().UTC()
	fixedClaude := intent.PoolID == "claude" && intent.Kind == "model"
	target := explicit
	if fixedClaude && target == "" && len(candidates) > 0 {
		target = claudePrimary(candidates[0].View)
		if target == "" {
			return configview.Selection{}, intent, &ChannelUnavailableError{}
		}
	}
	eligible := []configview.Selection{}
	recovery := []configview.Selection{}
	var retryAt time.Time
	priority := -1
	for _, candidate := range candidates {
		if target != "" && candidate.Channel.ID != target {
			continue
		}
		if intent.PoolID == "claude" && !candidate.Channel.Enabled {
			return configview.Selection{}, intent, &ChannelUnavailableError{}
		}
		current := intent
		current.ChannelID = candidate.Channel.ID
		current.CredentialRef = *candidate.Channel.CredentialRef
		current.CredentialVersion = *candidate.Channel.CredentialVersion
		var state string
		err = tx.QueryRowContext(ctx, `SELECT state FROM motai.channel_health WHERE pool_id=$1 AND channel_id=$2 AND credential_ref=$3 AND credential_version=$4`, current.PoolID, current.ChannelID, current.CredentialRef, current.CredentialVersion).Scan(&state)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return configview.Selection{}, intent, err
		}
		if state != "" && state != "available" && intent.Kind != "probe" {
			continue
		}
		var until time.Time
		var cooldownReason string
		if !fixedClaude {
			err = tx.QueryRowContext(ctx, `SELECT until_at,reason FROM motai.channel_cooldowns WHERE cooldown_key=$1`, cooldownKey(current)).Scan(&until, &cooldownReason)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return configview.Selection{}, intent, err
			}
		}
		if until.After(now) && intent.Kind != "probe" {
			if retryAt.IsZero() || until.Before(retryAt) {
				retryAt = until
			}
			continue
		}
		// Expiry permits one recovery attempt before normal routing resumes.
		if cooldownReason == "ordinary" && intent.Kind != "probe" {
			if currentEpoch == intent.PoolEpoch {
				recovery = append(recovery, candidate)
			}
			continue
		}
		if !until.IsZero() {
			if _, err = tx.ExecContext(ctx, `DELETE FROM motai.failure_windows WHERE scope_key=$1 AND channel_id=$2 AND credential_version=$3 AND window_started<$4`, intent.Affinity.Digest, current.ChannelID, current.CredentialVersion, until); err != nil {
				return configview.Selection{}, intent, err
			}
		}
		if candidate.Channel.Priority > priority {
			eligible = nil
			priority = candidate.Channel.Priority
		}
		if candidate.Channel.Priority == priority {
			eligible = append(eligible, candidate)
		}
	}
	recovering := false
	if len(recovery) > 0 {
		sort.SliceStable(recovery, func(i, j int) bool { return recovery[i].Channel.Priority > recovery[j].Channel.Priority })
		for _, candidate := range recovery {
			if len(eligible) > 0 && candidate.Channel.Priority <= priority {
				break
			}
			current := intent
			current.ChannelID, current.CredentialVersion = candidate.Channel.ID, *candidate.Channel.CredentialVersion
			var until time.Time
			var cooldownReason string
			err = tx.QueryRowContext(ctx, `SELECT until_at,reason FROM motai.channel_cooldowns WHERE cooldown_key=$1 FOR UPDATE`, cooldownKey(current)).Scan(&until, &cooldownReason)
			if errors.Is(err, sql.ErrNoRows) {
				eligible = []configview.Selection{candidate}
				break
			}
			if err != nil {
				return configview.Selection{}, intent, err
			}
			if until.After(now) {
				if retryAt.IsZero() || until.Before(retryAt) {
					retryAt = until
				}
				continue
			}
			if cooldownReason == "ordinary" {
				var inFlight bool
				if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM motai.attempts WHERE pool_id=$1 AND channel_id=$2 AND model_id=$3 AND kind='model' AND terminal IS NULL AND intent->>'protocol'=$4 AND intent->>'credential_version'=$5)`, current.PoolID, current.ChannelID, current.ModelCanonical, current.Protocol, current.CredentialVersion).Scan(&inFlight); err != nil {
					return configview.Selection{}, intent, err
				}
				if inFlight {
					if retryAt.IsZero() {
						retryAt = now.Add(60 * time.Second)
					}
					continue
				}
				if _, err = tx.ExecContext(ctx, `UPDATE motai.channel_cooldowns SET until_at=$2 WHERE cooldown_key=$1`, cooldownKey(current), now.Add(60*time.Second)); err != nil {
					return configview.Selection{}, intent, err
				}
				recovering = true
			}
			eligible = []configview.Selection{candidate}
			break
		}
	}
	if len(eligible) == 0 {
		return configview.Selection{}, intent, &ChannelUnavailableError{RetryAt: retryAt}
	}
	selected := eligible[0]
	reason := "priority_weight"
	found := false
	if explicit != "" {
		reason = "explicit_channel"
	} else if !fixedClaude && expires.After(now) {
		for _, candidate := range eligible {
			if candidate.Channel.ID == bound && *candidate.Channel.CredentialVersion == version {
				selected = candidate
				reason = "affinity_" + intent.Affinity.Scope
				found = true
				break
			}
		}
	}
	if !fixedClaude && !found && explicit == "" {
		weight := int64(0)
		for _, candidate := range eligible {
			weight += int64(candidate.Channel.Weight)
		}
		upper := weight
		if upper == 0 {
			upper = int64(len(eligible))
		}
		roll, e := rand.Int(rand.Reader, big.NewInt(upper))
		if e != nil {
			return configview.Selection{}, intent, e
		}
		if weight == 0 {
			selected = eligible[roll.Int64()]
		} else {
			remaining := roll.Int64()
			for _, candidate := range eligible {
				remaining -= int64(candidate.Channel.Weight)
				if remaining < 0 {
					selected = candidate
					break
				}
			}
		}
	}
	intent.ChannelID = selected.Channel.ID
	intent.ChannelName = selected.Channel.Name
	intent.ModelUpstream = selected.UpstreamModel
	intent.CredentialRef = *selected.Channel.CredentialRef
	intent.CredentialVersion = *selected.Channel.CredentialVersion
	intent.RouteReason = reason
	if intent.Kind == "probe" {
		intent.RouteReason = "probe_explicit"
	}
	for _, model := range selected.View.Config.Models {
		if model.ID == selected.Model {
			intent.Vendor = model.Vendor
			break
		}
	}
	data, err := json.Marshal(intent)
	if err != nil {
		return configview.Selection{}, intent, err
	}
	if err = r.Validator.Validate("intent", data); err != nil {
		return configview.Selection{}, intent, ErrInvalidIntent
	}
	if intent.Kind == "model" && currentEpoch == intent.PoolEpoch && !recovering {
		if _, err = tx.ExecContext(ctx, `INSERT INTO motai.affinity_bindings(scope_key,pool_id,epoch,channel_id,credential_version,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_key) DO UPDATE SET channel_id=excluded.channel_id,credential_version=excluded.credential_version,expires_at=excluded.expires_at`, intent.Affinity.Digest, intent.PoolID, intent.PoolEpoch, intent.ChannelID, intent.CredentialVersion, now.Add(time.Duration(selected.View.Config.Affinity.TTLSeconds)*time.Second)); err != nil {
			return configview.Selection{}, intent, err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO motai.attempts(attempt_id,boot_id,intent,started_at,pool_id,channel_id,model_id,kind,stream) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, intent.AttemptID, r.BootID, data, intent.StartedAt, intent.PoolID, intent.ChannelID, intent.ModelCanonical, intent.Kind, intent.Stream); err != nil {
		return configview.Selection{}, intent, err
	}
	if err = tx.Commit(); err != nil {
		return configview.Selection{}, intent, err
	}
	committed = true
	r.inflight.Add(1)
	return selected, intent, nil
}

// The configured Claude primary is chosen before capability, permission and health filters.
func claudePrimary(view *configview.View) string {
	var primary configview.Channel
	for _, channel := range view.Config.Channels {
		for _, pool := range channel.Pools() {
			if pool == "claude" && (primary.ID == "" || channel.PriorityForPool(pool) > primary.PriorityForPool(pool) ||
				channel.PriorityForPool(pool) == primary.PriorityForPool(pool) && channel.ID < primary.ID) {
				primary = channel
			}
		}
	}
	return primary.ID
}
func (r *Runtime) Complete(intent Intent, terminal Terminal, ttl int) {
	r.mu.Lock()
	r.waiting[intent.AttemptID] = time.Now()
	r.pending.Add(1)
	r.mu.Unlock()
	r.inflight.Add(-1)
	<-r.sendSlots
	r.queue <- completion{intent, terminal, ttl}
}
func (r *Runtime) worker() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		var item completion
		select {
		case item = <-r.queue:
		case <-ticker.C:
			r.mu.Lock()
			if r.fenced.Load() || len(r.held) == 0 {
				r.mu.Unlock()
				continue
			}
			item = r.held[0]
			r.held[0] = completion{}
			r.held = r.held[1:]
			r.mu.Unlock()
		case <-r.stop:
			return
		}
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err = r.commit(ctx, item)
			cancel()
			if err == nil || errors.Is(err, errRuntimeFenced) {
				break
			}
			if attempt < 2 {
				time.Sleep(time.Duration(attempt+1) * 250 * time.Millisecond)
			}
		}
		if err != nil {
			r.mu.Lock()
			r.held = append(r.held, item)
			r.failed.Store(true)
			r.mu.Unlock()
			ticker.Reset(5 * time.Second)
			continue
		}
		r.mu.Lock()
		delete(r.waiting, item.intent.AttemptID)
		if r.pending.Add(-1) == 0 && !r.fenced.Load() {
			r.failed.Store(false)
		}
		r.mu.Unlock()
		<-r.slots
	}
}
func (r *Runtime) SetAccepting(accepting bool) {
	r.mu.Lock()
	if accepting && r.fenced.Load() {
		r.mu.Unlock()
		return
	}
	r.draining.Store(!accepting)
	if accepting {
		held := r.held
		r.held = nil
		// Resume retries retained writes without admitting around an unresolved ledger.
		if r.pending.Load() == 0 {
			r.failed.Store(false)
		}
		r.mu.Unlock()
		for _, item := range held {
			r.queue <- item
		}
		return
	}
	r.mu.Unlock()
}
func (r *Runtime) Status(ctx context.Context) map[string]any {
	reasons := []string{}
	if r.completionOverdue() {
		reasons = append(reasons, "completion_wait_exceeded")
	}
	if r.fenced.Load() {
		reasons = append(reasons, "runtime_lease_lost")
	}
	if r.draining.Load() {
		reasons = append(reasons, "draining")
	}
	if r.failed.Load() {
		reasons = append(reasons, "completion_write_failed")
	}
	if len(r.slots) == cap(r.slots) {
		reasons = append(reasons, "completion_queue_full")
	}
	if len(r.sendSlots) == cap(r.sendSlots) {
		reasons = append(reasons, "in_flight_limit")
	}
	seq, err := r.LatestSeq(ctx)
	if err != nil {
		seq = "0"
		reasons = append(reasons, "storage_unavailable")
	}
	refs := []string{}
	rows, refErr := r.Store.Runtime.QueryContext(ctx, `SELECT DISTINCT a.intent->>'gen' FROM motai.attempts a WHERE a.terminal IS NULL AND NOT EXISTS(SELECT 1 FROM motai.probe_completion_quarantine q WHERE q.attempt_id=a.attempt_id) LIMIT 10000`)
	if refErr == nil {
		for rows.Next() {
			var gen string
			if rows.Scan(&gen) == nil {
				refs = append(refs, gen)
			}
		}
		rows.Close()
	}
	value := map[string]any{"in_flight": r.inflight.Load(), "completion_pending": r.pending.Load(), "completion_capacity": cap(r.slots), "latest_seq": seq, "degraded_reasons": reasons, "referenced_gens": refs}
	var quarantined int64
	if r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.probe_completion_quarantine`).Scan(&quarantined) == nil {
		value["probe_completion_quarantined"] = quarantined
	}
	return value
}
func (r *Runtime) LatestSeq(ctx context.Context) (string, error) {
	var seq string
	err := r.Store.Runtime.QueryRowContext(ctx, `SELECT seq::text FROM motai.event_seq WHERE singleton=1`).Scan(&seq)
	return seq, err
}
func (r *Runtime) recover(ctx context.Context) error {
	rows, err := r.Store.Runtime.QueryContext(ctx, `SELECT a.intent FROM motai.attempts a WHERE a.terminal IS NULL AND a.boot_id<>$1 AND NOT EXISTS(SELECT 1 FROM motai.probe_completion_quarantine q WHERE q.attempt_id=a.attempt_id) ORDER BY a.started_at,a.attempt_id`, r.BootID)
	if err != nil {
		return err
	}
	intents := []Intent{}
	for rows.Next() {
		var data []byte
		var intent Intent
		if err = rows.Scan(&data); err != nil {
			rows.Close()
			return err
		}
		if err = json.Unmarshal(data, &intent); err != nil {
			rows.Close()
			return err
		}
		intents = append(intents, intent)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, intent := range intents {
		now := time.Now().UTC()
		terminal := Terminal{1, intent.AttemptID, now, now.Sub(intent.StartedAt).Milliseconds(), nil, "interrupted", "interrupted", "unknown", nil, "missing", 0, str("process_interrupted"), "none", usage.Normalize("unknown", map[string]int64{}, true), nil, nil}
		if err = r.commit(ctx, completion{intent, terminal, 0}); err != nil {
			return err
		}
	}
	tx, err := r.Store.Runtime.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = r.guardLease(ctx, tx); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE motai.probe_runs SET response=jsonb_set(response,'{state}','"interrupted"'::jsonb) WHERE boot_id<>$1 AND response->>'state' IN ('accepted','running')`, r.BootID); err != nil {
		return err
	}
	return tx.Commit()
}
