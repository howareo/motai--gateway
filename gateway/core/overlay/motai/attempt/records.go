package attempt

import (
	"github.com/QuantumNous/new-api/motai/usage"
	"time"
)

type Effort struct {
	Value  *string `json:"value"`
	Source *string `json:"source"`
}
type Affinity struct {
	Scope  string `json:"scope"`
	Digest string `json:"digest"`
}
type Intent struct {
	FormatVersion     int       `json:"format_version"`
	Source            string    `json:"source"`
	RequestID         string    `json:"request_id"`
	AttemptID         string    `json:"attempt_id"`
	Kind              string    `json:"kind"`
	Gen               string    `json:"gen"`
	PoolEpoch         string    `json:"pool_epoch"`
	CallerID          string    `json:"caller_id"`
	ChannelID         string    `json:"channel_id"`
	ChannelName       string    `json:"channel_name"`
	PoolID            string    `json:"pool_id"`
	ModelRequested    string    `json:"model_requested"`
	ModelCanonical    string    `json:"model_canonical"`
	ModelUpstream     string    `json:"model_upstream"`
	Vendor            string    `json:"vendor"`
	Protocol          string    `json:"protocol"`
	Stream            bool      `json:"stream"`
	Effort            Effort    `json:"effort"`
	ThinkingBudget    *int64    `json:"thinking_budget"`
	StartedAt         time.Time `json:"started_at"`
	RouteReason       string    `json:"route_reason"`
	CredentialRef     string    `json:"credential_ref"`
	CredentialVersion string    `json:"credential_version"`
	Affinity          Affinity  `json:"affinity"`
	AttemptNo         int       `json:"attempt_no"`
}
type Terminal struct {
	FormatVersion    int          `json:"format_version"`
	AttemptID        string       `json:"attempt_id"`
	EndedAt          time.Time    `json:"ended_at"`
	DurationMS       int64        `json:"duration_ms"`
	TTFTMS           *int64       `json:"ttft_ms"`
	RequestOutcome   string       `json:"request_outcome"`
	AttemptOutcome   string       `json:"attempt_outcome"`
	SendCertainty    string       `json:"send_certainty"`
	UpstreamStatus   *int         `json:"upstream_status"`
	ProtocolTerminal string       `json:"protocol_terminal"`
	ClientBytes      int64        `json:"client_bytes"`
	ErrorClass       *string      `json:"error_class"`
	ChannelEffect    string       `json:"channel_effect"`
	Usage            usage.Record `json:"usage"`
	RetryAfterUntil  *time.Time   `json:"-"`
	// ErrorDetail is the sanitized upstream error text (at most 512 runes). Absent on success and on client cancellation.
	ErrorDetail *string `json:"error_detail,omitempty"`
}
type Record struct {
	FormatVersion int      `json:"format_version"`
	Intent        Intent   `json:"intent"`
	Terminal      Terminal `json:"terminal"`
}
type Event struct {
	FormatVersion int    `json:"format_version"`
	Seq           string `json:"seq"`
	EventType     string `json:"event_type"`
	Attempt       Record `json:"attempt"`
}

func str(value string) *string { return &value }
