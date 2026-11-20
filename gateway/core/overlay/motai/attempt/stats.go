package attempt

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

func zeroCounts() map[string]int64 {
	return map[string]int64{"requests": 0, "attempts": 0, "requests_succeeded": 0, "probes": 0, "probes_succeeded": 0}
}
func zeroTokens() map[string]int64 {
	return map[string]int64{"total_input": 0, "input_uncached": 0, "cache_read": 0, "cache_write_5m": 0, "cache_write_1h": 0, "cache_write_unknown": 0, "output_total": 0, "reasoning": 0}
}
func zeroCoverage() map[string]int64 {
	return map[string]int64{"attempts": 0, "usage_known": 0, "usage_partial": 0, "usage_unknown": 0, "estimated": 0}
}
func (r *Runtime) Stats(ctx context.Context, q Query) (map[string]any, error) {
	if !q.From.Before(q.To) || q.To.Sub(q.From) > 366*24*time.Hour {
		return nil, errors.New("invalid_contract")
	}
	snapshot, err := r.LatestSeq(ctx)
	if err != nil {
		return nil, err
	}
	if q.SnapshotSeq != nil {
		requested, e := strconv.ParseInt(*q.SnapshotSeq, 10, 64)
		latest, _ := strconv.ParseInt(snapshot, 10, 64)
		if e != nil || requested < 0 || requested > latest {
			return nil, errors.New("snapshot_invalid")
		}
		snapshot = *q.SnapshotSeq
	}
	rows, err := r.Store.Runtime.QueryContext(ctx, `WITH selected AS (
 SELECT kind,terminal->>'request_outcome' AS outcome,terminal->'usage' AS u FROM motai.attempts
 WHERE terminal IS NOT NULL AND started_at >= $1 AND started_at < $2 AND terminal_seq<=$3::bigint
 AND ($4::text IS NULL OR channel_id=$4) AND ($5::text IS NULL OR pool_id=$5) AND ($6::text IS NULL OR model_id=$6)
 AND ($7::text IS NULL OR kind=$7) AND (cardinality($8::text[])=0 OR terminal->>'attempt_outcome'=ANY($8::text[])) AND ($9::boolean IS NULL OR stream=$9)
 ), fields AS (SELECT *,ARRAY[u->'total_input',u->'input_uncached',u->'cache_read',u->'cache_write'->'ttl_5m',u->'cache_write'->'ttl_1h',u->'cache_write'->'ttl_unknown',u->'output_total',u->'reasoning'] AS f FROM selected)
 SELECT count(*),count(*) FILTER(WHERE kind='model'),count(*) FILTER(WHERE kind='model' AND outcome='succeeded'),count(*) FILTER(WHERE kind='probe'),count(*) FILTER(WHERE kind='probe' AND outcome='succeeded'),
 COALESCE(sum((u->'total_input'->>'value')::bigint),0)::text,COALESCE(sum((u->'input_uncached'->>'value')::bigint),0)::text,COALESCE(sum((u->'cache_read'->>'value')::bigint),0)::text,
 COALESCE(sum((u->'cache_write'->'ttl_5m'->>'value')::bigint),0)::text,COALESCE(sum((u->'cache_write'->'ttl_1h'->>'value')::bigint),0)::text,COALESCE(sum((u->'cache_write'->'ttl_unknown'->>'value')::bigint),0)::text,
 COALESCE(sum((u->'output_total'->>'value')::bigint),0)::text,COALESCE(sum((u->'reasoning'->>'value')::bigint),0)::text,
 count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM unnest(f) x WHERE x->>'value' IS NULL)),
 count(*) FILTER(WHERE EXISTS(SELECT 1 FROM unnest(f) x WHERE x->>'value' IS NULL) AND EXISTS(SELECT 1 FROM unnest(f) x WHERE x->>'value' IS NOT NULL)),
 count(*) FILTER(WHERE NOT EXISTS(SELECT 1 FROM unnest(f) x WHERE x->>'value' IS NOT NULL)),
 count(*) FILTER(WHERE EXISTS(SELECT 1 FROM unnest(f) x WHERE x->>'availability'='estimated')) FROM fields`, q.From, q.To, snapshot, q.ChannelID, q.PoolID, q.ModelID, q.Kind, q.Outcomes, q.Stream)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts, tokens, coverage := zeroCounts(), zeroTokens(), zeroCoverage()
	var attempts, requests, succeeded, probes, probesOK, known, partial, unknown, estimated int64
	tokenText := make([]string, 8)
	if !rows.Next() {
		return nil, errors.New("statistics unavailable")
	}
	err = rows.Scan(&attempts, &requests, &succeeded, &probes, &probesOK, &tokenText[0], &tokenText[1], &tokenText[2], &tokenText[3], &tokenText[4], &tokenText[5], &tokenText[6], &tokenText[7], &known, &partial, &unknown, &estimated)
	if err != nil {
		return nil, err
	}
	counts["attempts"], counts["requests"], counts["requests_succeeded"], counts["probes"], counts["probes_succeeded"] = attempts, requests, succeeded, probes, probesOK
	coverage["attempts"], coverage["usage_known"], coverage["usage_partial"], coverage["usage_unknown"], coverage["estimated"] = attempts, known, partial, unknown, estimated
	for index, key := range []string{"total_input", "input_uncached", "cache_read", "cache_write_5m", "cache_write_1h", "cache_write_unknown", "output_total", "reasoning"} {
		value, e := strconv.ParseInt(tokenText[index], 10, 64)
		if e != nil || value < 0 || value > 9007199254740991 {
			return nil, errors.New("statistics overflow")
		}
		tokens[key] = value
	}
	value := map[string]any{"format_version": 1, "from": q.From, "to": q.To, "snapshot_seq": snapshot, "counts": counts, "tokens": tokens, "coverage": coverage, "buckets": []any{}}
	data, _ := json.Marshal(value)
	if err = r.Validator.Validate("stats_response", data); err != nil {
		return nil, err
	}
	return value, rows.Err()
}
