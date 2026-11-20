package configview

import (
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAuthenticationAndEmptyReachability(t *testing.T) {
	key := []byte("stable-synthetic-hmac-key-for-tests")
	caller := Caller{ID: "caller", Enabled: true, SubjectEnabled: true, TokenHMAC: TokenHMAC(key, "token"), AllowedIPs: []string{"10.10.0.0/16"}}
	view := &View{Config: Config{Callers: []Caller{caller}}}
	_, err := view.Authenticate(key, "token", "10.10.0.2", time.Now())
	require.NoError(t, err)
	for _, test := range []struct{ token, ip string }{{"bad", "10.10.0.2"}, {"token", "192.168.1.1"}} {
		_, err = view.Authenticate(key, test.token, test.ip, time.Now())
		assert.Error(t, err)
	}
	_, err = view.Candidates(caller, "known-model", "responses", "", "")
	assert.Error(t, err, "an empty permission set must deny")
	caller.SubjectEnabled = false
	view.Config.Callers = []Caller{caller}
	_, err = view.Authenticate(key, "token", "10.10.0.2", time.Now())
	assert.Error(t, err)
}

func TestCapturedViewKeepsCredentialAndPermissions(t *testing.T) {
	caller := Caller{Permissions: []Permission{{PoolID: "pool", ModelIDs: []string{"Model"}, ChannelIDs: []string{"channel"}, Protocols: []string{"responses"}}}}
	old := &View{Config: Config{Gen: "1", Channels: []Channel{{ID: "channel", PoolID: "pool", Enabled: true, Secret: "synthetic-old",
		Models: []ChannelModel{{ModelID: "Model", UpstreamModel: "ProviderModel", Capabilities: []string{"responses"}}}}}}, Epochs: map[string]string{"pool": "1"}}
	selections, err := old.Candidates(caller, "Model", "responses", "", "")
	require.NoError(t, err)
	manager := &Manager{}
	manager.current.Store(old)
	manager.current.Store(&View{Config: Config{Gen: "2"}})
	assert.Equal(t, "synthetic-old", selections[0].Channel.Secret)
	assert.Equal(t, "1", selections[0].View.Config.Gen)
	_, err = manager.Snapshot().Candidates(caller, "Model", "responses", "", "")
	assert.Error(t, err)
}

func TestPoolScopedAliasesRespectReachabilityAndExplicitPool(t *testing.T) {
	view := &View{Config: Config{Gen: "1", Channels: []Channel{
		{ID: "channel-a", PoolID: "pool-a", Enabled: true, Models: []ChannelModel{{ModelID: "model-a", UpstreamModel: "upstream-a", Capabilities: []string{"responses"}}}},
		{ID: "channel-b", PoolID: "pool-b", Enabled: true, Models: []ChannelModel{{ModelID: "model-b", UpstreamModel: "upstream-b", Capabilities: []string{"responses"}}}},
	}, Aliases: []Alias{{Alias: "shared", ModelID: "model-a", PoolID: "pool-a"}, {Alias: "shared", ModelID: "model-b", PoolID: "pool-b"}}},
		Epochs: map[string]string{"pool-a": "1", "pool-b": "2"}}
	permissionA := Permission{PoolID: "pool-a", ModelIDs: []string{"model-a"}, ChannelIDs: []string{"channel-a"}, Protocols: []string{"responses"}}
	permissionB := Permission{PoolID: "pool-b", ModelIDs: []string{"model-b"}, ChannelIDs: []string{"channel-b"}, Protocols: []string{"responses"}}
	callerB := Caller{Permissions: []Permission{permissionB}}
	for _, pool := range []string{"", "pool-b"} {
		selected, err := view.Candidates(callerB, "shared", "responses", pool, "")
		require.NoError(t, err)
		require.Len(t, selected, 1)
		assert.Equal(t, "pool-b", selected[0].Pool)
		assert.Equal(t, "model-b", selected[0].Model)
		assert.Equal(t, "upstream-b", selected[0].UpstreamModel)
	}
	_, err := view.Candidates(callerB, "shared", "responses", "pool-a", "")
	require.EqualError(t, err, "permission_denied")
	_, err = view.Candidates(callerB, "shared", "responses", "missing-pool", "")
	require.EqualError(t, err, "permission_denied")
	both := Caller{Permissions: []Permission{permissionA, permissionB}}
	_, err = view.Candidates(both, "shared", "responses", "", "")
	require.EqualError(t, err, "ambiguous_pool")
	selected, err := view.Candidates(both, "shared", "responses", "pool-a", "")
	require.NoError(t, err)
	require.Len(t, selected, 1)
	assert.Equal(t, "model-a", selected[0].Model)
	selected, err = view.Candidates(callerB, "model-b", "responses", "", "")
	require.NoError(t, err)
	require.Len(t, selected, 1)
	assert.Equal(t, "pool-b", selected[0].Pool)
	view.Config.Channels[0].Enabled = false
	selected, err = view.Candidates(both, "shared", "responses", "", "")
	require.NoError(t, err)
	require.Len(t, selected, 1)
	assert.Equal(t, "pool-b", selected[0].Pool)
}

func TestMultiPoolCandidatesUseExactPermissionsPriorityAliasesAndEpoch(t *testing.T) {
	channel := Channel{ID: "shared", PoolID: "a", PoolIDs: []string{"a", "b"}, PoolPriorities: map[string]int{"b": 42}, Priority: 3, Enabled: true,
		Models: []ChannelModel{{ModelID: "model", UpstreamModel: "upstream", Capabilities: []string{"responses"}}}}
	view := &View{Config: Config{Channels: []Channel{channel}, Aliases: []Alias{{PoolID: "b", Alias: "friendly", ModelID: "model"}}}, Epochs: map[string]string{"a": "7", "b": "9"}}
	permission := Permission{PoolID: "b", ModelIDs: []string{"model"}, ChannelIDs: []string{"shared"}, Protocols: []string{"responses"}}
	caller := Caller{Permissions: []Permission{permission}}
	for _, pool := range []string{"", "b"} {
		selected, err := view.Candidates(caller, "friendly", "responses", pool, "")
		require.NoError(t, err)
		require.Len(t, selected, 1)
		require.Equal(t, "b", selected[0].Pool)
		require.Equal(t, "9", selected[0].Epoch)
		require.Equal(t, 42, selected[0].Channel.Priority)
		require.Equal(t, "shared", selected[0].Channel.ID)
	}
	_, err := view.Candidates(caller, "model", "responses", "a", "")
	require.EqualError(t, err, "permission_denied")
	permission.PoolID = "a"
	caller.Permissions = append(caller.Permissions, permission)
	_, err = view.Candidates(caller, "model", "responses", "", "")
	require.EqualError(t, err, "ambiguous_pool")
	selected, err := view.Candidates(caller, "model", "responses", "a", "")
	require.NoError(t, err)
	require.Equal(t, 3, selected[0].Channel.Priority)
	_, err = channel.ResolvePool("")
	require.EqualError(t, err, "invalid_contract")
	_, err = channel.ResolvePool("missing")
	require.EqualError(t, err, "invalid_contract")
	pool, err := (Channel{PoolID: "legacy"}).ResolvePool("")
	require.NoError(t, err)
	require.Equal(t, "legacy", pool)
}

func TestPoolFingerprintIgnoresOtherMembershipAndPriority(t *testing.T) {
	config := Config{Channels: []Channel{{ID: "shared", PoolID: "a", PoolIDs: []string{"a", "b"}, Priority: 3}}}
	a, err := poolFingerprint(config, "a")
	require.NoError(t, err)
	b, err := poolFingerprint(config, "b")
	require.NoError(t, err)
	config.Channels[0].PoolPriorities = map[string]int{"b": 42}
	afterA, err := poolFingerprint(config, "a")
	require.NoError(t, err)
	afterB, err := poolFingerprint(config, "b")
	require.NoError(t, err)
	require.Equal(t, a, afterA)
	require.NotEqual(t, b, afterB)
	config.Channels[0].PoolID = "b"
	config.Channels[0].PoolIDs = []string{"b", "a", "c"}
	afterA, err = poolFingerprint(config, "a")
	require.NoError(t, err)
	require.Equal(t, a, afterA)
	config.Channels[0].PoolIDs = []string{"b", "c"}
	afterA, err = poolFingerprint(config, "a")
	require.NoError(t, err)
	require.NotEqual(t, a, afterA)
}

func TestPoolFingerprintIncludesAdapterForEveryChannelMembership(t *testing.T) {
	config := Config{Channels: []Channel{{ID: "shared", PoolID: "a", PoolIDs: []string{"a", "b"}}}}
	before := map[string]string{}
	for _, pool := range []string{"a", "b", "unrelated"} {
		value, err := poolFingerprint(config, pool)
		require.NoError(t, err)
		before[pool] = value
	}
	config.Channels[0].Adapter = "deepseek"
	for _, pool := range []string{"a", "b", "unrelated"} {
		after, err := poolFingerprint(config, pool)
		require.NoError(t, err)
		if pool == "unrelated" {
			require.Equal(t, before[pool], after)
		} else {
			require.NotEqual(t, before[pool], after)
		}
	}
}

func wildcardView() *View {
	only := func(protocol string) []string { return []string{protocol} }
	return &View{Config: Config{Gen: "1",
		Models:  []Model{{ID: "m1"}, {ID: "m2"}, {ID: "only-other"}, {ID: "shared"}},
		Aliases: []Alias{{Alias: "friendly", ModelID: "m1", PoolID: "pool-a"}},
		Channels: []Channel{
			{ID: "ch-a", PoolID: "pool-a", Enabled: true, Models: []ChannelModel{
				{ModelID: "m1", UpstreamModel: "u1", Capabilities: only("responses")},
				{ModelID: "m2", UpstreamModel: "u2", Capabilities: []string{"responses", "messages"}},
				{ModelID: "shared", UpstreamModel: "us", Capabilities: only("responses")}}},
			{ID: "ch-off", PoolID: "pool-a", Enabled: false, Models: []ChannelModel{{ModelID: "m1", Capabilities: only("responses")}}},
			{ID: "ch-other", PoolID: "pool-a", Enabled: true, Models: []ChannelModel{{ModelID: "only-other", Capabilities: only("responses")}}},
			{ID: "ch-b", PoolID: "pool-b", Enabled: true, Models: []ChannelModel{{ModelID: "shared", UpstreamModel: "us-b", Capabilities: only("responses")}}},
		}, Callers: nil},
		Epochs: map[string]string{"pool-a": "1", "pool-b": "2"}}
}

func wildcardPermission(pool string, channels ...string) Permission {
	return Permission{PoolID: pool, ModelIDs: []string{WildcardModel}, ChannelIDs: channels, Protocols: []string{"responses", "messages"}}
}

func TestWildcardPermitsOnlyModelsTheListedChannelsProvide(t *testing.T) {
	view := wildcardView()
	caller := Caller{Permissions: []Permission{wildcardPermission("pool-a", "ch-a")}}
	for _, model := range []string{"m1", "m2", "shared"} {
		selected, err := view.Candidates(caller, model, "responses", "", "")
		require.NoError(t, err, model)
		require.Len(t, selected, 1)
		assert.Equal(t, "ch-a", selected[0].Channel.ID)
		assert.Equal(t, "pool-a", selected[0].Pool)
	}
	// A model that exists globally but not on a listed channel is not granted by "*".
	_, err := view.Candidates(caller, "only-other", "responses", "", "")
	require.EqualError(t, err, "permission_denied")
	_, err = view.Candidates(caller, "unknown-model", "responses", "", "")
	require.EqualError(t, err, "permission_denied")
	// The channel's own protocol check is unchanged: m1 has no messages capability.
	_, err = view.Candidates(caller, "m1", "messages", "", "")
	require.EqualError(t, err, "permission_denied")
	selected, err := view.Candidates(caller, "m2", "messages", "", "")
	require.NoError(t, err)
	assert.Equal(t, "ch-a", selected[0].Channel.ID)
	// The permission's own protocol list still limits what "*" grants.
	_, err = view.Candidates(Caller{Permissions: []Permission{{PoolID: "pool-a", ModelIDs: []string{"*"}, ChannelIDs: []string{"ch-a"}, Protocols: []string{"messages"}}}}, "m1", "responses", "", "")
	require.EqualError(t, err, "permission_denied")
}

func TestWildcardResolvesAliasesAndSkipsDisabledChannels(t *testing.T) {
	view := wildcardView()
	caller := Caller{Permissions: []Permission{wildcardPermission("pool-a", "ch-a", "ch-off")}}
	selected, err := view.Candidates(caller, "friendly", "responses", "", "")
	require.NoError(t, err)
	require.Len(t, selected, 1, "the disabled channel offering the same model is skipped")
	assert.Equal(t, "ch-a", selected[0].Channel.ID)
	assert.Equal(t, "m1", selected[0].Model)
	assert.Equal(t, "u1", selected[0].UpstreamModel)
	onlyDisabled := Caller{Permissions: []Permission{wildcardPermission("pool-a", "ch-off")}}
	_, err = view.Candidates(onlyDisabled, "m1", "responses", "", "")
	require.EqualError(t, err, "permission_denied")
	// An alias is only a name inside its own pool.
	_, err = view.Candidates(caller, "friendly", "responses", "pool-b", "")
	require.EqualError(t, err, "permission_denied")
}

func TestWildcardGroupsAndExplicitListsBehaveAsBefore(t *testing.T) {
	view := wildcardView()
	grouped := Permission{PoolID: "pool-a", ModelIDs: []string{"*"}, ChannelIDs: []string{"ch-a"}, Protocols: []string{"responses"}, Groups: []string{"team"}}
	_, err := view.Candidates(Caller{Permissions: []Permission{grouped}}, "m1", "responses", "", "other")
	require.EqualError(t, err, "permission_denied")
	_, err = view.Candidates(Caller{Permissions: []Permission{grouped}}, "m1", "responses", "", "team")
	require.NoError(t, err)
	explicit := Caller{Permissions: []Permission{{PoolID: "pool-a", ModelIDs: []string{"m1"}, ChannelIDs: []string{"ch-a"}, Protocols: []string{"responses"}}}}
	_, err = view.Candidates(explicit, "m1", "responses", "", "")
	require.NoError(t, err)
	_, err = view.Candidates(explicit, "m2", "responses", "", "")
	require.EqualError(t, err, "permission_denied", "an explicit list still names only its own models")
}

func TestPermitsModelTreatsWildcardOnlyAsTheSoleElement(t *testing.T) {
	assert.True(t, Permission{ModelIDs: []string{"*"}}.PermitsModel("anything"))
	assert.True(t, Permission{ModelIDs: []string{"a", "b"}}.PermitsModel("b"))
	assert.False(t, Permission{ModelIDs: []string{"a", "b"}}.PermitsModel("c"))
	// Domain validation rejects a mixed list; if one ever reached the router it must not grant everything.
	assert.False(t, Permission{ModelIDs: []string{"*", "a"}}.PermitsModel("c"))
	assert.False(t, Permission{}.PermitsModel("c"))
}

func TestWildcardDoesNotCreateAmbiguousPoolBeyondExplicitLists(t *testing.T) {
	view := wildcardView()
	wild := Caller{Permissions: []Permission{wildcardPermission("pool-a", "ch-a"), wildcardPermission("pool-b", "ch-b")}}
	explicit := Caller{Permissions: []Permission{
		{PoolID: "pool-a", ModelIDs: []string{"shared"}, ChannelIDs: []string{"ch-a"}, Protocols: []string{"responses", "messages"}},
		{PoolID: "pool-b", ModelIDs: []string{"shared"}, ChannelIDs: []string{"ch-b"}, Protocols: []string{"responses", "messages"}}}}
	for _, test := range []struct{ model, protocol, pool string }{
		{"shared", "responses", ""}, {"shared", "responses", "pool-a"}, {"shared", "responses", "pool-b"}, {"shared", "responses", "missing"},
		{"m1", "responses", ""}, {"m2", "messages", ""}, {"only-other", "responses", ""},
	} {
		want, wantErr := view.Candidates(explicit, test.model, test.protocol, test.pool, "")
		got, gotErr := view.Candidates(wild, test.model, test.protocol, test.pool, "")
		if test.model == "m1" || test.model == "m2" {
			// The explicit list above names only "shared"; compare against a list that names the same model instead.
			want, wantErr = view.Candidates(Caller{Permissions: []Permission{
				{PoolID: "pool-a", ModelIDs: []string{test.model}, ChannelIDs: []string{"ch-a"}, Protocols: []string{"responses", "messages"}},
				{PoolID: "pool-b", ModelIDs: []string{test.model}, ChannelIDs: []string{"ch-b"}, Protocols: []string{"responses", "messages"}}}}, test.model, test.protocol, test.pool, "")
		}
		if wantErr != nil || gotErr != nil {
			require.EqualError(t, gotErr, wantErr.Error(), "%+v", test)
			continue
		}
		require.Len(t, got, len(want), "%+v", test)
		for i := range want {
			assert.Equal(t, want[i].Channel.ID, got[i].Channel.ID)
			assert.Equal(t, want[i].Pool, got[i].Pool)
		}
	}
	// Two wildcard pools that share a model are ambiguous exactly like two explicit lists, and resolve with the pool header.
	_, err := view.Candidates(wild, "shared", "responses", "", "")
	require.EqualError(t, err, "ambiguous_pool")
	selected, err := view.Candidates(wild, "shared", "responses", "pool-b", "")
	require.NoError(t, err)
	assert.Equal(t, "ch-b", selected[0].Channel.ID)
}

func fullWildcard(pool string) Permission {
	return Permission{PoolID: pool, ModelIDs: []string{WildcardModel}, ChannelIDs: []string{WildcardModel}, Protocols: []string{WildcardModel}}
}

func TestWildcardChannelsCoverEveryEnabledChannelOfThePermissionPool(t *testing.T) {
	view := wildcardView()
	caller := Caller{Permissions: []Permission{{PoolID: "pool-a", ModelIDs: []string{WildcardModel}, ChannelIDs: []string{WildcardModel}, Protocols: []string{"responses", "messages"}}}}
	for model, channel := range map[string]string{"m1": "ch-a", "m2": "ch-a", "shared": "ch-a", "only-other": "ch-other"} {
		selected, err := view.Candidates(caller, model, "responses", "", "")
		require.NoError(t, err, model)
		require.Len(t, selected, 1, "%s: the disabled ch-off and the other pool's ch-b never join", model)
		assert.Equal(t, channel, selected[0].Channel.ID)
		assert.Equal(t, "pool-a", selected[0].Pool)
	}
	// The wildcard names channels of its own pool only: pool-b's channel is not reachable through pool-a's permission.
	_, err := view.Candidates(caller, "shared", "responses", "pool-b", "")
	require.EqualError(t, err, "permission_denied")
	// A channel added to the pool later is usable with no permission change.
	view.Config.Channels = append(view.Config.Channels, Channel{ID: "ch-new", PoolID: "pool-a", Enabled: true,
		Models: []ChannelModel{{ModelID: "m1", UpstreamModel: "u-new", Capabilities: []string{"responses"}}}})
	selected, err := view.Candidates(caller, "m1", "responses", "", "")
	require.NoError(t, err)
	assert.Equal(t, []string{"ch-a", "ch-new"}, []string{selected[0].Channel.ID, selected[1].Channel.ID})
	// A disabled channel stays skipped even when it is the only one that offers the model.
	view.Config.Models = append(view.Config.Models, Model{ID: "off-only"})
	view.Config.Channels[1].Models = append(view.Config.Channels[1].Models, ChannelModel{ModelID: "off-only", Capabilities: []string{"responses"}})
	_, err = view.Candidates(caller, "off-only", "responses", "", "")
	require.EqualError(t, err, "permission_denied")
}

func TestWildcardChannelsMatchOnlyThePermissionPoolOfAMultiPoolChannel(t *testing.T) {
	view := wildcardView()
	view.Config.Models = append(view.Config.Models, Model{ID: "multi"})
	view.Config.Channels = append(view.Config.Channels, Channel{ID: "ch-multi", PoolID: "pool-a", PoolIDs: []string{"pool-a", "pool-b"}, Enabled: true,
		PoolPriorities: map[string]int{"pool-a": 3, "pool-b": 9},
		Models:         []ChannelModel{{ModelID: "multi", UpstreamModel: "um", Capabilities: []string{"responses"}}}})
	onlyA := Caller{Permissions: []Permission{fullWildcard("pool-a")}}
	selected, err := view.Candidates(onlyA, "multi", "responses", "", "")
	require.NoError(t, err)
	require.Len(t, selected, 1)
	assert.Equal(t, "pool-a", selected[0].Pool)
	assert.Equal(t, 3, selected[0].Channel.Priority)
	assert.Equal(t, "1", selected[0].Epoch)
	_, err = view.Candidates(onlyA, "multi", "responses", "pool-b", "")
	require.EqualError(t, err, "permission_denied")
	// A pool the channel does not belong to gets nothing from it.
	_, err = view.Candidates(Caller{Permissions: []Permission{fullWildcard("pool-c")}}, "multi", "responses", "", "")
	require.EqualError(t, err, "permission_denied")
	// With both pools granted the model is ambiguous until the pool header picks one, exactly as with explicit lists.
	both := Caller{Permissions: []Permission{fullWildcard("pool-a"), fullWildcard("pool-b")}}
	_, err = view.Candidates(both, "multi", "responses", "", "")
	require.EqualError(t, err, "ambiguous_pool")
	selected, err = view.Candidates(both, "multi", "responses", "pool-b", "")
	require.NoError(t, err)
	assert.Equal(t, 9, selected[0].Channel.Priority)
	assert.Equal(t, "2", selected[0].Epoch)
}

func TestWildcardProtocolsStillFollowChannelModelCapabilities(t *testing.T) {
	view := wildcardView()
	view.Config.Channels[0].Models = append(view.Config.Channels[0].Models,
		ChannelModel{ModelID: "counter", Capabilities: []string{"count_tokens"}}, ChannelModel{ModelID: "gem", Capabilities: []string{"gemini_generate_content"}})
	view.Config.Models = append(view.Config.Models, Model{ID: "counter"}, Model{ID: "gem"})
	caller := Caller{Permissions: []Permission{{PoolID: "pool-a", ModelIDs: []string{"*"}, ChannelIDs: []string{"ch-a"}, Protocols: []string{WildcardModel}}}}
	for _, test := range []struct {
		model, protocol string
		ok              bool
	}{
		{"m1", "responses", true}, {"m2", "messages", true}, {"counter", "count_tokens", true}, {"gem", "gemini_generate_content", true},
		// "*" is not a capability: the channel model must still list the protocol.
		{"m1", "messages", false}, {"m1", "count_tokens", false}, {"counter", "responses", false}, {"gem", "responses", false}, {"m1", "*", false},
	} {
		_, err := view.Candidates(caller, test.model, test.protocol, "", "")
		if test.ok {
			require.NoError(t, err, "%+v", test)
		} else {
			require.EqualError(t, err, "permission_denied", "%+v", test)
		}
	}
	// The same permission with an explicit protocol list keeps limiting what it grants.
	narrow := Caller{Permissions: []Permission{{PoolID: "pool-a", ModelIDs: []string{"*"}, ChannelIDs: []string{"ch-a"}, Protocols: []string{"responses"}}}}
	_, err := view.Candidates(narrow, "counter", "count_tokens", "", "")
	require.EqualError(t, err, "permission_denied")
}

func TestPermitsChannelAndProtocolTreatWildcardOnlyAsTheSoleElement(t *testing.T) {
	assert.True(t, Permission{ChannelIDs: []string{"*"}}.PermitsChannel("anything"))
	assert.True(t, Permission{ChannelIDs: []string{"a", "b"}}.PermitsChannel("b"))
	assert.False(t, Permission{ChannelIDs: []string{"a", "b"}}.PermitsChannel("c"))
	assert.False(t, Permission{ChannelIDs: []string{"*", "a"}}.PermitsChannel("c"), "a mixed list must not grant everything")
	assert.False(t, Permission{}.PermitsChannel("c"))
	assert.True(t, Permission{Protocols: []string{"*"}}.PermitsProtocol("count_tokens"))
	assert.True(t, Permission{Protocols: []string{"responses", "messages"}}.PermitsProtocol("messages"))
	assert.False(t, Permission{Protocols: []string{"responses", "messages"}}.PermitsProtocol("count_tokens"))
	assert.False(t, Permission{Protocols: []string{"*", "responses"}}.PermitsProtocol("messages"), "a mixed list must not grant everything")
	assert.False(t, Permission{}.PermitsProtocol("responses"))
}

// expandedPermission spells out what a fully wildcarded permission stands for: every channel that lists the pool
// (enabled or not), every configured model and every protocol.
func expandedPermission(config Config, pool string) Permission {
	permission := Permission{PoolID: pool, Protocols: []string{"responses", "chat_completions", "messages", "gemini_generate_content", "count_tokens"}}
	for _, model := range config.Models {
		permission.ModelIDs = append(permission.ModelIDs, model.ID)
	}
	for _, channel := range config.Channels {
		if slices.Contains(channel.Pools(), pool) {
			permission.ChannelIDs = append(permission.ChannelIDs, channel.ID)
		}
	}
	return permission
}

func TestFullWildcardMatchesTheExplicitListOfThePoolKeyByKey(t *testing.T) {
	view := wildcardView()
	view.Config.Models = append(view.Config.Models, Model{ID: "multi"}, Model{ID: "counter"}, Model{ID: "gem"}, Model{ID: "unused"})
	view.Config.Aliases = append(view.Config.Aliases, Alias{Alias: "friendly", ModelID: "shared", PoolID: "pool-b"}, Alias{Alias: "multi-alias", ModelID: "multi", PoolID: "pool-b"})
	view.Config.Channels = append(view.Config.Channels,
		Channel{ID: "ch-multi", PoolID: "pool-a", PoolIDs: []string{"pool-a", "pool-b"}, Enabled: true, PoolPriorities: map[string]int{"pool-a": 3, "pool-b": 9},
			Models: []ChannelModel{{ModelID: "multi", UpstreamModel: "um", Capabilities: []string{"responses", "count_tokens"}}, {ModelID: "shared", UpstreamModel: "us-m", Capabilities: []string{"responses"}}}},
		Channel{ID: "ch-tools", PoolID: "pool-b", Enabled: true, Models: []ChannelModel{{ModelID: "counter", Capabilities: []string{"count_tokens"}}, {ModelID: "gem", Capabilities: []string{"gemini_generate_content", "chat_completions"}}}},
		Channel{ID: "ch-lonely", PoolID: "pool-c", Enabled: true, Models: []ChannelModel{{ModelID: "m1", UpstreamModel: "ul", Capabilities: []string{"responses", "messages"}}}})
	pools := []string{"pool-a", "pool-b", "pool-c"}
	wild := func(pool ...string) Caller {
		caller := Caller{}
		for _, id := range pool {
			caller.Permissions = append(caller.Permissions, fullWildcard(id))
		}
		return caller
	}
	explicit := func(pool ...string) Caller {
		caller := Caller{}
		for _, id := range pool {
			caller.Permissions = append(caller.Permissions, expandedPermission(view.Config, id))
		}
		return caller
	}
	names := []string{"unknown", "friendly", "multi-alias"}
	for _, model := range view.Config.Models {
		names = append(names, model.ID)
	}
	protocols := []string{"responses", "chat_completions", "messages", "gemini_generate_content", "count_tokens", "unsupported"}
	headers := append([]string{""}, append(pools, "missing")...)
	key := func(selected []Selection) []string {
		keys := []string{}
		for _, selection := range selected {
			keys = append(keys, strings.Join([]string{selection.Channel.ID, selection.Pool, selection.Model, selection.UpstreamModel, selection.Protocol, selection.Epoch, strconv.Itoa(selection.Channel.Priority)}, "|"))
		}
		return keys
	}
	var compared, routed, ambiguous int
	for _, grant := range [][]string{{"pool-a"}, {"pool-b"}, {"pool-c"}, {"pool-a", "pool-b"}, {"pool-a", "pool-c"}, {"pool-a", "pool-b", "pool-c"}} {
		for _, name := range names {
			for _, protocol := range protocols {
				for _, header := range headers {
					label := strings.Join(grant, "+") + "/" + name + "/" + protocol + "/" + header
					want, wantErr := view.Candidates(explicit(grant...), name, protocol, header, "")
					got, gotErr := view.Candidates(wild(grant...), name, protocol, header, "")
					compared++
					if wantErr != nil || gotErr != nil {
						require.Error(t, wantErr, label)
						require.EqualError(t, gotErr, wantErr.Error(), label)
						if wantErr.Error() == "ambiguous_pool" {
							ambiguous++
						}
						continue
					}
					routed++
					require.Equal(t, key(want), key(got), label)
				}
			}
		}
	}
	// The sweep must really exercise routes and the ambiguous_pool rule, not just agree on denials.
	assert.Greater(t, routed, 100)
	assert.GreaterOrEqual(t, ambiguous, 5)
	t.Logf("compared %d keys: %d routed, %d ambiguous_pool", compared, routed, ambiguous)
}
