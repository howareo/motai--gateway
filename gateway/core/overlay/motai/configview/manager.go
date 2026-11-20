package configview

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"slices"
	"sort"
	"sync"
	"sync/atomic"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/QuantumNous/new-api/motai/store"
)

type Manager struct {
	Directory string
	Validator *contract.Validator
	Store     *store.Store
	Forbidden []string
	current   atomic.Pointer[View]
	write     sync.Mutex
	lkg       *string
	invalid   atomic.Bool
}

func (m *Manager) Snapshot() *View { return m.current.Load() }

func (m *Manager) Recover(ctx context.Context) error {
	committed, err := m.Store.ReadCommitted(ctx)
	if err != nil {
		return err
	}
	if committed == nil {
		return nil
	}
	view, _, err := Load(m.Directory, FileRef{committed.ManifestFile, committed.ManifestSHA256}, m.Validator, m.Forbidden)
	if err != nil {
		m.invalid.Store(true)
		return err
	}
	view.Epochs, err = m.Store.Epochs(ctx)
	if err != nil {
		return err
	}
	if view.Config.Gen != committed.Gen {
		m.invalid.Store(true)
		return errors.New("committed generation mismatch")
	}
	m.lkg = committed.LKG
	m.current.Store(view)
	return nil
}

type ActivateRequest struct {
	FormatVersion    int     `json:"format_version"`
	Gen              string  `json:"gen"`
	ManifestSHA256   string  `json:"manifest_sha256"`
	BaseCommittedGen *string `json:"base_committed_gen"`
}
type ActivateResponse struct {
	FormatVersion  int    `json:"format_version"`
	Gen            string `json:"gen"`
	ManifestSHA256 string `json:"manifest_sha256"`
	CommittedGen   string `json:"committed_gen"`
	ServingGen     string `json:"serving_gen"`
}

func (m *Manager) Activate(ctx context.Context, request ActivateRequest) (ActivateResponse, error) {
	m.write.Lock()
	defer m.write.Unlock()
	pointer, err := ReadDesired(m.Directory, m.Validator)
	if err != nil {
		return ActivateResponse{}, errors.New("invalid_config")
	}
	if pointer.Gen != request.Gen || pointer.Manifest.SHA256 != request.ManifestSHA256 {
		return ActivateResponse{}, errors.New("generation_conflict")
	}
	view, manifest, err := Load(m.Directory, pointer.Manifest, m.Validator, m.Forbidden)
	if err != nil {
		return ActivateResponse{}, errors.New("invalid_config")
	}
	if manifest.Gen != request.Gen || !equalNullable(manifest.BaseGen, request.BaseCommittedGen) {
		return ActivateResponse{}, errors.New("generation_conflict")
	}
	fingerprints := map[string]string{}
	for _, pool := range view.Config.Pools {
		fingerprint, fingerprintErr := poolFingerprint(view.Config, pool.ID)
		if fingerprintErr != nil {
			return ActivateResponse{}, fingerprintErr
		}
		fingerprints[pool.ID] = fingerprint
	}
	view.Epochs, err = m.Store.Activate(ctx, request.Gen, pointer.Manifest.File, pointer.Manifest.SHA256, request.BaseCommittedGen, fingerprints)
	if err != nil {
		return ActivateResponse{}, err
	}
	previous := m.current.Load()
	if previous != nil && previous.Config.Gen != request.Gen {
		gen := previous.Config.Gen
		m.lkg = &gen
	}
	m.current.Store(view)
	m.invalid.Store(false)
	return ActivateResponse{1, request.Gen, request.ManifestSHA256, request.Gen, request.Gen}, nil
}

func poolFingerprint(config Config, poolID string) (string, error) {
	channels := []Channel{}
	for _, channel := range config.Channels {
		if slices.Contains(channel.Pools(), poolID) {
			channel.Name = ""
			channel.Secret = ""
			channel.AccountRef = nil
			channel.Priority = channel.PriorityForPool(poolID)
			channel.PoolID = poolID
			channel.PoolIDs = nil
			channel.PoolPriorities = nil
			channels = append(channels, channel)
		}
	}
	sort.Slice(channels, func(i, j int) bool { return channels[i].ID < channels[j].ID })
	aliases := []Alias{}
	for _, alias := range config.Aliases {
		if alias.PoolID == poolID {
			aliases = append(aliases, alias)
		}
	}
	sort.Slice(aliases, func(i, j int) bool { return aliases[i].Alias < aliases[j].Alias })
	data, err := common.Marshal(struct {
		Channels []Channel
		Aliases  []Alias
	}{channels, aliases})
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:]), nil
}

func equalNullable(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

func (m *Manager) Status(ctx context.Context, build string) map[string]any {
	m.write.Lock()
	defer m.write.Unlock()
	var desired, committed, serving *string
	reasons := []string{}
	if pointer, err := ReadDesired(m.Directory, m.Validator); err == nil {
		desired = &pointer.Gen
	} else if !os.IsNotExist(err) {
		reasons = append(reasons, "configuration_invalid")
	}
	if value, err := m.Store.ReadCommitted(ctx); err == nil {
		if value != nil {
			committed = &value.Gen
		}
	} else {
		reasons = append(reasons, "storage_unavailable")
	}
	view := m.current.Load()
	refs := []string{}
	if view != nil {
		gen := view.Config.Gen
		serving = &gen
		refs = append(refs, gen)
	} else {
		reasons = append(reasons, "not_activated")
	}
	if m.lkg != nil {
		refs = append(refs, *m.lkg)
	}
	return map[string]any{"format_version": 1, "build_id": build, "ready": view != nil && len(reasons) == 0, "desired_gen": desired, "committed_gen": committed,
		"serving_gen": serving, "lkg_gen": m.lkg, "degraded_reasons": reasons, "in_flight": 0, "completion_pending": 0, "completion_capacity": 0, "latest_seq": "0", "referenced_gens": refs}
}
