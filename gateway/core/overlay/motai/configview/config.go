package configview

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"slices"
	"time"
)

type Model struct {
	ID     string `json:"id"`
	Vendor string `json:"vendor"`
}
type ChannelModel struct {
	ModelID       string   `json:"model_id"`
	UpstreamModel string   `json:"upstream_model"`
	Capabilities  []string `json:"capabilities"`
}
type Channel struct {
	ID                string         `json:"id"`
	Name              string         `json:"name"`
	PoolID            string         `json:"pool_id"`
	PoolIDs           []string       `json:"pool_ids,omitempty"`
	PoolPriorities    map[string]int `json:"pool_priorities,omitempty"`
	Enabled           bool           `json:"enabled"`
	Priority          int            `json:"priority"`
	Weight            int            `json:"weight"`
	BaseURL           string         `json:"base_url"`
	Adapter           string         `json:"adapter,omitempty"`
	CredentialRef     *string        `json:"credential_ref"`
	CredentialVersion *string        `json:"credential_version"`
	AccountRef        *string        `json:"account_ref"`
	Models            []ChannelModel `json:"models"`
	Secret            string         `json:"-"`
}

func (c Channel) Pools() []string {
	if c.PoolIDs != nil {
		return c.PoolIDs
	}
	return []string{c.PoolID}
}

func (c Channel) PriorityForPool(pool string) int {
	if priority, ok := c.PoolPriorities[pool]; ok {
		return priority
	}
	return c.Priority
}

// An omitted pool is only unambiguous for a channel with one membership.
func (c Channel) ResolvePool(pool string) (string, error) {
	if pool == "" && len(c.Pools()) == 1 {
		return c.Pools()[0], nil
	}
	if slices.Contains(c.Pools(), pool) {
		return pool, nil
	}
	return "", errors.New("invalid_contract")
}

type Permission struct {
	PoolID     string   `json:"pool_id"`
	ModelIDs   []string `json:"model_ids"`
	ChannelIDs []string `json:"channel_ids"`
	Protocols  []string `json:"protocols"`
	Groups     []string `json:"groups"`
}

// WildcardModel is the only element of a permission list (model_ids, channel_ids or protocols) that grants
// everything the list can name: every model, every channel of the permission pool, every protocol.
const WildcardModel = "*"

// isWildcard reports whether the list is exactly ["*"].
func isWildcard(list []string) bool {
	return len(list) == 1 && list[0] == WildcardModel
}

// PermitsModel reports whether the permission names modelID. A model_ids list of exactly ["*"] names every model;
// whether a listed channel really provides the model and protocol is still decided by the caller.
func (p Permission) PermitsModel(modelID string) bool {
	return isWildcard(p.ModelIDs) || slices.Contains(p.ModelIDs, modelID)
}

// PermitsChannel reports whether the permission names channelID. A channel_ids list of exactly ["*"] names every
// channel; the caller still checks that the channel is enabled and belongs to the permission pool.
func (p Permission) PermitsChannel(channelID string) bool {
	return isWildcard(p.ChannelIDs) || slices.Contains(p.ChannelIDs, channelID)
}

// PermitsProtocol reports whether the permission names protocol. A protocols list of exactly ["*"] names every
// protocol; the caller still checks that the channel model supports it.
func (p Permission) PermitsProtocol(protocol string) bool {
	return isWildcard(p.Protocols) || slices.Contains(p.Protocols, protocol)
}

type Caller struct {
	ID               string       `json:"id"`
	Name             string       `json:"name"`
	Enabled          bool         `json:"enabled"`
	SubjectEnabled   bool         `json:"subject_enabled"`
	TokenHMAC        string       `json:"token_hmac"`
	TokenHMACAliases []string     `json:"token_hmac_aliases,omitempty"`
	ExpiresAt        *time.Time   `json:"expires_at"`
	AllowedIPs       []string     `json:"allowed_ips"`
	Permissions      []Permission `json:"permissions"`
}
type Alias struct {
	Alias   string `json:"alias"`
	ModelID string `json:"model_id"`
	PoolID  string `json:"pool_id"`
}
type Pool struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Config struct {
	FormatVersion int       `json:"format_version"`
	Gen           string    `json:"gen"`
	Pools         []Pool    `json:"pools"`
	Channels      []Channel `json:"channels"`
	Models        []Model   `json:"models"`
	Aliases       []Alias   `json:"aliases"`
	Callers       []Caller  `json:"callers"`
	Affinity      struct {
		Enabled    bool `json:"enabled"`
		TTLSeconds int  `json:"ttl_seconds"`
	} `json:"affinity"`
	FailurePolicy struct {
		MaxAttempts          int `json:"max_attempts"`
		RetryAfterMaxSeconds int `json:"retry_after_max_seconds"`
	} `json:"failure_policy"`
}
type Credentials struct {
	Gen     string `json:"gen"`
	Entries []struct {
		Ref     string `json:"credential_ref"`
		Version string `json:"credential_version"`
		Secret  string `json:"secret"`
	} `json:"entries"`
}
type View struct {
	Config   Config
	Manifest FileRef
	Epochs   map[string]string
}
type Selection struct {
	View          *View
	Caller        Caller
	Channel       Channel
	Model         string
	UpstreamModel string
	Pool          string
	Protocol      string
	Epoch         string
}

func TokenHMAC(key []byte, token string) string {
	hash := hmac.New(sha256.New, key)
	hash.Write([]byte("motai-caller-v1\x00"))
	hash.Write([]byte(token))
	return hex.EncodeToString(hash.Sum(nil))
}

func (v *View) Authenticate(key []byte, token, ip string, now time.Time) (Caller, error) {
	wanted := TokenHMAC(key, token)
	for _, caller := range v.Config.Callers {
		matched := hmac.Equal([]byte(caller.TokenHMAC), []byte(wanted))
		for _, alias := range caller.TokenHMACAliases {
			matched = hmac.Equal([]byte(alias), []byte(wanted)) || matched
		}
		if !matched {
			continue
		}
		if !caller.Enabled || !caller.SubjectEnabled || (caller.ExpiresAt != nil && !now.Before(*caller.ExpiresAt)) {
			break
		}
		if len(caller.AllowedIPs) > 0 {
			allowed := false
			for _, limit := range caller.AllowedIPs {
				if limit == ip {
					allowed = true
					break
				}
				_, network, err := net.ParseCIDR(limit)
				if err == nil && network.Contains(net.ParseIP(ip)) {
					allowed = true
					break
				}
			}
			if !allowed {
				break
			}
		}
		return caller, nil
	}
	return Caller{}, errors.New("permission_denied")
}

func (v *View) Candidates(caller Caller, requested, protocol, requestedPool, group string) ([]Selection, error) {
	result := []Selection{}
	for _, channel := range v.Config.Channels {
		for _, pool := range channel.Pools() {
			// Claude admission must see a disabled primary and fail closed.
			if !channel.Enabled && pool != "claude" {
				continue
			}
			if requestedPool != "" && pool != requestedPool {
				continue
			}
			modelID := requested
			for _, alias := range v.Config.Aliases {
				if alias.Alias == requested && alias.PoolID == pool {
					modelID = alias.ModelID
					break
				}
			}
			permitted := false
			for _, permission := range caller.Permissions {
				if permission.PoolID == pool && permission.PermitsModel(modelID) &&
					permission.PermitsChannel(channel.ID) && permission.PermitsProtocol(protocol) &&
					(len(permission.Groups) == 0 || slices.Contains(permission.Groups, group)) {
					permitted = true
					break
				}
			}
			if !permitted {
				continue
			}
			for _, model := range channel.Models {
				if model.ModelID == modelID && slices.Contains(model.Capabilities, protocol) {
					selected := channel
					selected.Priority = channel.PriorityForPool(pool)
					result = append(result, Selection{v, caller, selected, modelID, model.UpstreamModel, pool, protocol, v.Epochs[pool]})
				}
			}
		}
	}
	if len(result) == 0 {
		return nil, errors.New("permission_denied")
	}
	actualPool := result[0].Pool
	for _, selection := range result {
		if selection.Pool != actualPool {
			return nil, errors.New("ambiguous_pool")
		}
	}
	return result, nil
}
