package attempt

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/QuantumNous/new-api/motai/contract"
	"github.com/stretchr/testify/require"
)

func TestPostgresAttemptsReverseCursorAndFilteredTotal(t *testing.T) {
	r, candidates, makeIntent := ledgerTestRuntime(t)
	ctx := context.Background()
	from := time.Now().UTC().Add(-time.Hour).Truncate(time.Millisecond)
	to := from.Add(10 * time.Second)
	add := func(offset time.Duration, stream, cooldown bool) Intent {
		intent := makeIntent()
		intent.StartedAt = from.Add(offset)
		intent.Stream = stream
		_, intent, err := r.Admit(ctx, candidates, intent, "")
		require.NoError(t, err)
		terminal := ledgerSuccess(intent)
		if stream {
			terminal.ProtocolTerminal = "completed"
		}
		r.Complete(intent, terminal, 3600)
		require.Eventually(t, func() bool { return r.pending.Load() == 0 }, time.Second, time.Millisecond)
		if cooldown {
			_, err = r.Store.Runtime.ExecContext(ctx, `UPDATE motai.attempts SET terminal=jsonb_set(terminal,'{channel_effect}','"cooldown"') WHERE attempt_id=$1`, intent.AttemptID)
			require.NoError(t, err)
		}
		return intent
	}
	want := []Intent{add(0, false, true), add(0, false, true), add(time.Second, false, true)}
	sort.Slice(want[:2], func(i, j int) bool { return want[i].AttemptID < want[j].AttemptID })
	add(2*time.Second, false, false)
	add(3*time.Second, true, true)
	add(10*time.Second, false, true)
	snapshot, err := r.LatestSeq(ctx)
	require.NoError(t, err)
	add(4*time.Second, false, true)
	stream := false
	channel, model, kind := "primary", "test-model", "model"
	q := Query{From: from, To: to, PoolID: &want[0].PoolID, ChannelID: &channel, ModelID: &model, Kind: &kind,
		Outcomes: []string{"succeeded"}, Stream: &stream, SnapshotSeq: &snapshot, Limit: 2, Reverse: true, CooldownOnly: true}
	page, err := r.Attempts(ctx, q)
	require.NoError(t, err)
	require.EqualValues(t, 3, page["total"])
	require.Equal(t, true, page["has_more"])
	records := page["attempts"].([]Record)
	require.Len(t, records, 2)
	require.Equal(t, want[0].AttemptID, records[0].Intent.AttemptID)
	require.Equal(t, want[1].AttemptID, records[1].Intent.AttemptID)
	q.Cursor = page["next_cursor"].(*string)
	page, err = r.Attempts(ctx, q)
	require.NoError(t, err)
	require.NotContains(t, page, "total")
	require.Equal(t, false, page["has_more"])
	records = page["attempts"].([]Record)
	require.Len(t, records, 1)
	require.Equal(t, want[2].AttemptID, records[0].Intent.AttemptID)
	q.Reverse = false
	_, err = r.Attempts(ctx, q)
	require.EqualError(t, err, "invalid_cursor")
	q.Reverse, q.CooldownOnly = true, false
	_, err = r.Attempts(ctx, q)
	require.EqualError(t, err, "invalid_cursor")
	q.Cursor, q.Reverse, q.CooldownOnly = nil, false, true
	page, err = r.Attempts(ctx, q)
	require.NoError(t, err)
	require.NotContains(t, page, "total")
	records = page["attempts"].([]Record)
	require.Len(t, records, 2)
	require.Equal(t, want[2].AttemptID, records[0].Intent.AttemptID)
	require.Equal(t, want[1].AttemptID, records[1].Intent.AttemptID)
}

func TestPostgresEventsRetainStoredJSONAndValidateRelations(t *testing.T) {
	r, candidates, makeIntent := ledgerTestRuntime(t)
	ctx := context.Background()
	after, err := r.LatestSeq(ctx)
	require.NoError(t, err)
	_, intent, err := r.Admit(ctx, candidates, makeIntent(), "")
	require.NoError(t, err)
	r.Complete(intent, ledgerSuccess(intent), 3600)
	require.Eventually(t, func() bool { return r.pending.Load() == 0 }, time.Second, time.Millisecond)
	page, err := r.Events(ctx, after, 1)
	require.NoError(t, err)
	data, err := json.Marshal(page)
	require.NoError(t, err)
	require.NoError(t, r.Validator.ValidatePage("events_page", data))
	var decoded struct {
		Events []Event `json:"events"`
	}
	require.NoError(t, json.Unmarshal(data, &decoded))
	require.Len(t, decoded.Events, 1)
	require.Equal(t, intent.AttemptID, decoded.Events[0].Attempt.Intent.AttemptID)
	require.True(t, intent.StartedAt.Equal(decoded.Events[0].Attempt.Intent.StartedAt))
	require.Equal(t, page["latest_seq"], page["next_seq"])
	require.Equal(t, false, page["has_more"])

	// Invalid stored fields must reach the complete output validator, not be
	// silently coerced or dropped by a typed intermediate representation.
	_, err = r.Store.Runtime.ExecContext(ctx, `UPDATE motai.attempts SET terminal=jsonb_set(terminal,'{upstream_status}','null') WHERE attempt_id=$1`, intent.AttemptID)
	require.NoError(t, err)
	page, err = r.Events(ctx, after, 1)
	require.NoError(t, err)
	data, err = json.Marshal(page)
	require.NoError(t, err)
	require.Error(t, r.Validator.ValidatePage("events_page", data))
}

func TestPostgresEventsPageBoundaries(t *testing.T) {
	r, candidates, makeIntent := ledgerTestRuntime(t)
	ctx := context.Background()
	after, err := r.LatestSeq(ctx)
	require.NoError(t, err)
	for i := 0; i < 2; i++ {
		_, intent, err := r.Admit(ctx, candidates, makeIntent(), "")
		require.NoError(t, err)
		r.Complete(intent, ledgerSuccess(intent), 3600)
		require.Eventually(t, func() bool { return r.pending.Load() == 0 }, time.Second, time.Millisecond)
	}

	latest, err := r.LatestSeq(ctx)
	require.NoError(t, err)
	data, err := r.Events(ctx, after, 1)
	require.NoError(t, err)
	encoded, err := json.Marshal(data)
	require.NoError(t, err)
	var page struct {
		Events    []Event `json:"events"`
		NextSeq   string  `json:"next_seq"`
		LatestSeq string  `json:"latest_seq"`
		HasMore   bool    `json:"has_more"`
	}
	require.NoError(t, json.Unmarshal(encoded, &page))
	require.Len(t, page.Events, 1)
	require.True(t, page.HasMore)
	require.Equal(t, latest, page.LatestSeq)
	require.Equal(t, page.Events[0].Seq, page.NextSeq)
	payload, err := r.EventsPayload(ctx, after, 1)
	require.NoError(t, err)
	require.NoError(t, r.Validator.ValidatePageValue("events_page", payload.ContractValue()))
	require.NoError(t, r.Validator.ValidatePage("events_page", payload.ContractData()))

	empty, err := r.Events(ctx, latest, 1)
	require.NoError(t, err)
	emptyEncoded, err := json.Marshal(empty)
	require.NoError(t, err)
	var emptyPage struct {
		Events    []Event `json:"events"`
		NextSeq   string  `json:"next_seq"`
		LatestSeq string  `json:"latest_seq"`
		HasMore   bool    `json:"has_more"`
	}
	require.NoError(t, json.Unmarshal(emptyEncoded, &emptyPage))
	require.Empty(t, emptyPage.Events)
	require.Equal(t, latest, emptyPage.NextSeq)
	require.Equal(t, latest, emptyPage.LatestSeq)
	require.False(t, emptyPage.HasMore)
	emptyPayload, err := r.EventsPayload(ctx, latest, 1)
	require.NoError(t, err)
	require.NoError(t, r.Validator.ValidatePageValue("events_page", emptyPayload.ContractValue()))
	require.NoError(t, r.Validator.ValidatePage("events_page", emptyPayload.ContractData()))
}

// TestEventsPageValidatesProducedValue feeds eventsPage events decoded the way
// EventsPayload decodes them and checks the produced page passes both
// validators, which only accept []interface{} for JSON arrays.
func TestEventsPageValidatesProducedValue(t *testing.T) {
	root := os.Getenv("MOTAI_CONTRACTS_DIR")
	require.NotEmpty(t, root)
	validator, err := contract.NewValidator(filepath.Join(root, "v1"))
	require.NoError(t, err)
	raw, err := os.ReadFile(filepath.Join(root, "fixtures", "internal-api-samples.json"))
	require.NoError(t, err)
	var fixtures struct {
		Samples map[string]json.RawMessage `json:"samples"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixtures))
	sample := func() map[string]any {
		decoded, err := contract.DecodeValue(fixtures.Samples["events_page"])
		require.NoError(t, err)
		return decoded.(map[string]any)
	}
	first := sample()["events"].([]any)[0].(map[string]any)
	second := sample()["events"].([]any)[0].(map[string]any)
	// The sample page is a single caught-up page: next_seq and latest_seq both
	// equal its only event seq. Add a later event so the page can be truncated.
	firstSeq := first["seq"].(string)
	secondSeq := "9007199254740996"
	require.Equal(t, "9007199254740995", firstSeq)
	second["seq"] = secondSeq
	after := "9007199254740994"

	validate := func(p PagePayload) {
		require.NoError(t, validator.ValidatePageValue("events_page", p.ContractValue()))
		require.NoError(t, validator.ValidatePage("events_page", p.ContractData()))
	}

	truncated, err := eventsPage(after, secondSeq, []any{first, second}, 1)
	require.NoError(t, err)
	value := truncated.ContractValue().(map[string]any)
	require.Equal(t, true, value["has_more"])
	require.Equal(t, firstSeq, value["next_seq"])
	require.Equal(t, secondSeq, value["latest_seq"])
	require.Len(t, value["events"], 1)
	validate(truncated)

	empty, err := eventsPage(secondSeq, secondSeq, []any{}, 1)
	require.NoError(t, err)
	value = empty.ContractValue().(map[string]any)
	require.Equal(t, false, value["has_more"])
	require.Equal(t, secondSeq, value["next_seq"])
	require.Empty(t, value["events"])
	validate(empty)
}
