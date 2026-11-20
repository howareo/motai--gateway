package nocharge

import (
	"os"

	"github.com/QuantumNous/new-api/motai/usage"
	"github.com/gin-gonic/gin"
)

func Enabled() bool { return os.Getenv("MOTAI_GATEWAY_NO_CHARGE") == "1" }

// Session satisfies the complete upstream BillingSettler without constructing funding.
type Session struct {
	Usage *usage.Record
}

func (*Session) Settle(int) error         { return nil }
func (*Session) Refund(*gin.Context)      {}
func (*Session) NeedsRefund() bool        { return false }
func (*Session) GetPreConsumedQuota() int { return 0 }
func (*Session) Reserve(int) error        { return nil }
