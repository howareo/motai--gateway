package helper

import (
	"net/http/httptest"
	"testing"

	"github.com/QuantumNous/new-api/common"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestMotaiPriceGateBypassesUnknownModelAndQuotaClamp(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	info := &relaycommon.RelayInfo{OriginModelName: "motai-never-priced-model", UserQuota: 0, QuotaClamp: &common.QuotaClamp{}}
	price, err := ModelPriceHelper(ctx, info, 100, &types.TokenCountMeta{MaxTokens: 100})
	require.NoError(t, err)
	assert.Zero(t, price.QuotaToPreConsume)
	assert.False(t, price.FreeModel, "PreConsumeBilling must still install a non-nil settler")
}
