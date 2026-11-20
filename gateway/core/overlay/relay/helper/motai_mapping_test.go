package helper_test

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/constant"
	"github.com/QuantumNous/new-api/middleware"
	"github.com/QuantumNous/new-api/model"
	"github.com/QuantumNous/new-api/motai/configview"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relay/helper"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMotaiAliasSelectionMapsThroughCanonicalContextToUpstream(t *testing.T) {
	view := &configview.View{Config: configview.Config{Channels: []configview.Channel{{ID: "channel", PoolID: "pool", Enabled: true,
		Models: []configview.ChannelModel{{ModelID: "canonical", UpstreamModel: "upstream", Capabilities: []string{"chat_completions"}}}}},
		Aliases: []configview.Alias{{Alias: "friendly", ModelID: "canonical", PoolID: "pool"}}}}
	caller := configview.Caller{Permissions: []configview.Permission{{PoolID: "pool", ModelIDs: []string{"canonical"}, ChannelIDs: []string{"channel"}, Protocols: []string{"chat_completions"}}}}
	selections, err := view.Candidates(caller, "friendly", "chat_completions", "", "")
	require.NoError(t, err)
	require.Len(t, selections, 1)
	selected := selections[0]
	mapping, err := json.Marshal(map[string]string{selected.Model: selected.UpstreamModel})
	require.NoError(t, err)
	mappingText, baseURL := string(mapping), "https://synthetic.invalid"
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	common.SetContextKey(ctx, constant.ContextKeyRequestStartTime, time.Now())
	require.Nil(t, middleware.SetupContextForSelectedChannel(ctx, &model.Channel{Id: 1, Type: constant.ChannelTypeOpenAI,
		Key: "synthetic-upstream-key", BaseURL: &baseURL, ModelMapping: &mappingText}, selected.Model))
	request := &dto.GeneralOpenAIRequest{Model: "friendly"}
	info := relaycommon.GenRelayInfoOpenAI(ctx, request)
	info.InitChannelMeta(ctx)
	assert.Equal(t, "canonical", info.OriginModelName)
	require.NoError(t, helper.ModelMappedHelper(ctx, info, request))
	assert.Equal(t, "upstream", info.UpstreamModelName)
	assert.Equal(t, "upstream", request.Model)
}
