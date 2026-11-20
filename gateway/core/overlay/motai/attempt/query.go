package attempt

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/motai/contract"
)

type Query struct {
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
	ChannelID    *string   `json:"channel_id"`
	PoolID       *string   `json:"pool_id"`
	ModelID      *string   `json:"model_id"`
	Kind         *string   `json:"kind"`
	Outcomes     []string  `json:"outcomes"`
	Stream       *bool     `json:"stream,omitempty"`
	SnapshotSeq  *string   `json:"snapshot_seq"`
	Cursor       *string   `json:"cursor"`
	Limit        int       `json:"limit"`
	Reverse      bool      `json:"reverse,omitempty"`
	CooldownOnly bool      `json:"cooldown_only,omitempty"`
}
type cursor struct {
	Filter   string    `json:"f"`
	Snapshot string    `json:"s"`
	Time     time.Time `json:"t"`
	ID       string    `json:"i"`
}

func (r *Runtime) sign(data []byte) string {
	mac := hmac.New(sha256.New, r.key)
	mac.Write([]byte("motai-cursor-v1\x00"))
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
func filterHash(q Query) string {
	q.Cursor = nil
	q.SnapshotSeq = nil
	data := mustJSON(q)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
func (r *Runtime) encodeCursor(value cursor) string {
	data := mustJSON(value)
	return base64.RawURLEncoding.EncodeToString(data) + "." + r.sign(data)
}
func (r *Runtime) decodeCursor(value string) (cursor, error) {
	var result cursor
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return result, errors.New("invalid_cursor")
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || !hmac.Equal([]byte(parts[1]), []byte(r.sign(data))) {
		return result, errors.New("invalid_cursor")
	}
	err = json.Unmarshal(data, &result)
	return result, err
}

type PagePayload struct {
	value map[string]any
	data  []byte
}

func (p PagePayload) ContractValue() any   { return p.value }
func (p PagePayload) ContractData() []byte { return p.data }

func (r *Runtime) Events(ctx context.Context, after string, limit int) (map[string]any, error) {
	payload, err := r.EventsPayload(ctx, after, limit)
	if err != nil {
		return nil, err
	}
	return payload.value, nil
}

func (r *Runtime) EventsPayload(ctx context.Context, after string, limit int) (PagePayload, error) {
	rows, err := r.Store.Runtime.QueryContext(ctx, `WITH latest AS (
	SELECT seq,seq::text AS latest_seq FROM motai.event_seq WHERE singleton=1
), event_page AS (
	SELECT e.seq,e.seq::text AS seq_text,a.intent,a.terminal
	FROM motai.attempt_events e
	JOIN motai.attempts a ON a.attempt_id=e.attempt_id
	JOIN latest ON e.seq<=latest.seq
	WHERE e.seq>$1::bigint
	ORDER BY e.seq
	LIMIT $2
)
SELECT latest.latest_seq,event_page.seq_text,event_page.intent,event_page.terminal
FROM latest LEFT JOIN event_page ON TRUE
ORDER BY event_page.seq`, after, limit+1)
	if err != nil {
		return PagePayload{}, err
	}
	defer rows.Close()
	events := make([]any, 0, limit+1)
	latest := ""
	seenLatest := false
	for rows.Next() {
		var latestValue, seq sql.NullString
		var intentData, terminalData []byte
		if err = rows.Scan(&latestValue, &seq, &intentData, &terminalData); err != nil {
			return PagePayload{}, err
		}
		if !latestValue.Valid {
			return PagePayload{}, sql.ErrNoRows
		}
		latest = latestValue.String
		seenLatest = true
		if !seq.Valid {
			continue
		}
		intent, decodeErr := contract.DecodeValue(intentData)
		if decodeErr != nil {
			return PagePayload{}, decodeErr
		}
		terminal, decodeErr := contract.DecodeValue(terminalData)
		if decodeErr != nil {
			return PagePayload{}, decodeErr
		}
		events = append(events, map[string]any{"format_version": 1, "seq": seq.String, "event_type": "attempt_terminal",
			"attempt": map[string]any{"format_version": 1, "intent": intent, "terminal": terminal}})
	}
	if err = rows.Err(); err != nil {
		return PagePayload{}, err
	}
	if !seenLatest {
		return PagePayload{}, sql.ErrNoRows
	}
	return eventsPage(after, latest, events, limit)
}

// eventsPage truncates the scanned events to limit and builds the page. Events
// are held as []any because the contract validators only accept the
// []interface{} shape produced by JSON decoding.
func eventsPage(after, latest string, events []any, limit int) (PagePayload, error) {
	more := len(events) > limit
	if more {
		events = events[:limit]
	}
	next := after
	if len(events) > 0 {
		event, ok := events[len(events)-1].(map[string]any)
		if !ok {
			return PagePayload{}, errors.New("invalid_event")
		}
		last, ok := event["seq"].(string)
		if !ok {
			return PagePayload{}, errors.New("invalid_event")
		}
		next = last
	}
	value := map[string]any{"format_version": 1, "events": events, "next_seq": next, "latest_seq": latest, "has_more": more}
	data, err := common.Marshal(value)
	if err != nil {
		return PagePayload{}, err
	}
	return PagePayload{value: value, data: data}, nil
}
func (r *Runtime) Attempts(ctx context.Context, q Query) (map[string]any, error) {
	if !q.From.Before(q.To) || q.To.Sub(q.From) > 366*24*time.Hour || q.Limit < 1 || q.Limit > 200 {
		return nil, errors.New("invalid_contract")
	}
	latest, err := r.LatestSeq(ctx)
	if err != nil {
		return nil, err
	}
	snapshot := latest
	if q.SnapshotSeq != nil {
		snapshot = *q.SnapshotSeq
	}
	s, e := strconv.ParseInt(snapshot, 10, 64)
	l, _ := strconv.ParseInt(latest, 10, 64)
	if e != nil || s < 0 || s > l {
		return nil, errors.New("invalid_contract")
	}
	args := []any{q.From, q.To, snapshot, q.ChannelID, q.PoolID, q.ModelID, q.Kind, q.Outcomes, q.Stream}
	where := ` WHERE terminal IS NOT NULL AND started_at >= $1 AND started_at < $2 AND terminal_seq<=$3::bigint
 AND ($4::text IS NULL OR channel_id=$4) AND ($5::text IS NULL OR pool_id=$5) AND ($6::text IS NULL OR model_id=$6)
 AND ($7::text IS NULL OR kind=$7) AND (cardinality($8::text[])=0 OR terminal->>'attempt_outcome'=ANY($8::text[])) AND ($9::boolean IS NULL OR stream=$9)`
	if q.CooldownOnly {
		where += ` AND terminal->>'channel_effect'='cooldown'`
	}
	var total int64
	if q.Reverse && q.Cursor == nil {
		if err := r.Store.Runtime.QueryRowContext(ctx, `SELECT count(*) FROM motai.attempts`+where, args...).Scan(&total); err != nil {
			return nil, err
		}
	}
	order := ` ORDER BY started_at DESC,attempt_id DESC`
	comparison := `<`
	if q.Reverse {
		order = ` ORDER BY started_at ASC,attempt_id ASC`
		comparison = `>`
	}
	if q.Cursor != nil {
		value, err := r.decodeCursor(*q.Cursor)
		if err != nil || value.Filter != filterHash(q) || value.Snapshot != snapshot {
			return nil, errors.New("invalid_cursor")
		}
		args = append(args, value.Time, value.ID)
		where += ` AND (started_at,attempt_id)` + comparison + `($10,$11::uuid)`
	}
	args = append(args, q.Limit+1)
	rows, err := r.Store.Runtime.QueryContext(ctx, `SELECT intent,terminal FROM motai.attempts`+where+order+` LIMIT $`+strconv.Itoa(len(args)), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	records := []Record{}
	for rows.Next() {
		var a, b []byte
		record := Record{FormatVersion: 1}
		if err = rows.Scan(&a, &b); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(a, &record.Intent); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(b, &record.Terminal); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	more := len(records) > q.Limit
	var next *string
	if more {
		records = records[:q.Limit]
		last := records[len(records)-1]
		value := r.encodeCursor(cursor{filterHash(q), snapshot, last.Intent.StartedAt, last.Intent.AttemptID})
		next = &value
	}
	page := map[string]any{"format_version": 1, "attempts": records, "snapshot_seq": snapshot, "next_cursor": next, "has_more": more}
	if q.Reverse && q.Cursor == nil {
		page["total"] = total
	}
	return page, nil
}
