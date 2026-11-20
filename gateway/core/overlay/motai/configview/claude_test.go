package configview

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestClaudeCandidatesKeepDisabledPrimaryForAdmission(t *testing.T) {
	view := wildcardView()
	view.Config.Channels[0].PoolID = "claude"
	view.Config.Channels[1].PoolID = "claude"
	caller := Caller{Permissions: []Permission{wildcardPermission("claude", "ch-a", "ch-off")}}
	selected, err := view.Candidates(caller, "m1", "responses", "claude", "")
	require.NoError(t, err)
	require.Len(t, selected, 2)
	require.False(t, selected[1].Channel.Enabled)
	view.Config.Channels[0].PoolID = "pool-a"
	view.Config.Channels[1].PoolID = "pool-a"
	caller.Permissions[0].PoolID = "pool-a"
	selected, err = view.Candidates(caller, "m1", "responses", "pool-a", "")
	require.NoError(t, err)
	require.Len(t, selected, 1)
	require.True(t, selected[0].Channel.Enabled)
}
