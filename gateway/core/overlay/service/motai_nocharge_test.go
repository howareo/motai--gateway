package service

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/nocharge"
	relaycommon "github.com/QuantumNous/new-api/relay/common"
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

var _ relaycommon.BillingSettler = (*nocharge.Session)(nil)

func TestMotaiNoChargeRetainsUsageWithoutFunding(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{UserId: 1, UserQuota: 0, TokenId: 1, StartTime: time.Now(), OriginModelName: "unknown-price",
		QuotaClamp: &common.QuotaClamp{}}
	require.Nil(t, PreConsumeBilling(ctx, -1, info), "NoCharge must bypass wallet and quota gates")
	session, ok := info.Billing.(*nocharge.Session)
	require.True(t, ok)
	require.NoError(t, session.Reserve(1_000_000))
	usage := &dto.Usage{PromptTokens: 100, CompletionTokens: 7, TotalTokens: 107}
	usage.PromptTokensDetails.CachedTokens = 20
	PostTextConsumeQuota(ctx, info, usage, nil)
	require.NotNil(t, session.Usage)
	require.NotNil(t, session.Usage.InputUncached.Value)
	assert.EqualValues(t, 80, *session.Usage.InputUncached.Value)
	assert.EqualValues(t, 7, *session.Usage.OutputTotal.Value)
	require.NoError(t, SettleBilling(ctx, info, 100))
	session.Refund(ctx)
	session.Refund(ctx)
	assert.False(t, session.NeedsRefund())
	assert.Zero(t, session.GetPreConsumedQuota())
	assert.False(t, ChargeViolationFeeIfNeeded(ctx, info, types.NewErrorWithStatusCode(assert.AnError, types.ErrorCodeInvalidRequest, 400)))
}

func TestMotaiPartialUsageSurvivesErrorWithoutUsage(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest("POST", "/v1/responses", nil)
	info := &relaycommon.RelayInfo{StartTime: time.Now()}
	ObserveMotaiUsage(ctx, info, &dto.Usage{PromptTokens: 10, CompletionTokens: 3}, true)
	ObserveMotaiUsage(ctx, info, nil, true)
	session := info.Billing.(*nocharge.Session)
	require.NotNil(t, session.Usage.OutputTotal.Value)
	assert.EqualValues(t, 3, *session.Usage.OutputTotal.Value)
	assert.Equal(t, "partial", session.Usage.OutputTotal.Completeness)
}

func TestMotaiUsageObservationAndQuotaHookAreIdempotent(t *testing.T) {
	t.Setenv("MOTAI_GATEWAY_NO_CHARGE", "1")
	ctx, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx.Request = httptest.NewRequest("POST", "/v1/chat/completions", nil)
	info := &relaycommon.RelayInfo{StartTime: time.Now()}
	observed := &dto.Usage{PromptTokens: 10, CompletionTokens: 3}
	ObserveMotaiUsage(ctx, info, observed, false)
	session := info.Billing.(*nocharge.Session)
	first := *session.Usage
	PostTextConsumeQuota(ctx, info, observed, nil)
	assert.Same(t, session, info.Billing)
	assert.Equal(t, first, *session.Usage, "the second hook replaces the same numeric snapshot without adding counters")
	PostAudioConsumeQuota(ctx, info, observed, "")
	assert.Equal(t, first, *session.Usage)
}
