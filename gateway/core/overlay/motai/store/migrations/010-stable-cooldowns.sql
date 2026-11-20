-- Copy current-epoch cooldowns; retain old keys for binary rollback.
-- Every field is UTF-8 followed by a NUL byte, matching Go's cooldownKey.
LOCK TABLE motai.channel_cooldowns IN SHARE ROW EXCLUSIVE MODE;

WITH identities AS (
 SELECT DISTINCT a.intent->>'pool_id' AS pool_id, a.intent->>'pool_epoch' AS pool_epoch,
  a.intent->>'model_canonical' AS model_id, a.intent->>'protocol' AS protocol,
  a.intent->>'channel_id' AS channel_id, a.intent->>'credential_version' AS credential_version
 FROM motai.attempts a JOIN motai.pool_state p
  ON p.pool_id=a.intent->>'pool_id' AND p.epoch::text=a.intent->>'pool_epoch'
 WHERE intent->>'pool_id' IS NOT NULL
  AND intent->>'pool_epoch' IS NOT NULL
  AND intent->>'model_canonical' IS NOT NULL
  AND intent->>'protocol' IS NOT NULL
  AND intent->>'channel_id' IS NOT NULL
  AND intent->>'credential_version' IS NOT NULL
), key_map AS (
 SELECT DISTINCT
  encode(sha256(
   convert_to(pool_id,'UTF8') || '\x00'::bytea ||
   convert_to(pool_epoch,'UTF8') || '\x00'::bytea ||
   convert_to(model_id,'UTF8') || '\x00'::bytea ||
   convert_to(protocol,'UTF8') || '\x00'::bytea ||
   convert_to(channel_id,'UTF8') || '\x00'::bytea ||
   convert_to(credential_version,'UTF8') || '\x00'::bytea
  ),'hex') AS old_key,
  encode(sha256(
   convert_to(pool_id,'UTF8') || '\x00'::bytea ||
   convert_to(model_id,'UTF8') || '\x00'::bytea ||
   convert_to(protocol,'UTF8') || '\x00'::bytea ||
   convert_to(channel_id,'UTF8') || '\x00'::bytea ||
   convert_to(credential_version,'UTF8') || '\x00'::bytea
  ),'hex') AS new_key
 FROM identities
), legacy AS (
 SELECT k.new_key, c.until_at, c.reason, c.observed_at
 FROM key_map k JOIN motai.channel_cooldowns c ON c.cooldown_key=k.old_key
 WHERE k.old_key<>k.new_key
), targets AS (
 SELECT DISTINCT new_key FROM legacy
), sources AS (
 SELECT * FROM legacy
 UNION ALL
 SELECT c.cooldown_key, c.until_at, c.reason, c.observed_at
 FROM motai.channel_cooldowns c JOIN targets t ON t.new_key=c.cooldown_key
), merged AS (
 SELECT new_key, max(until_at) AS until_at, max(observed_at) AS observed_at,
  (array_agg(reason ORDER BY observed_at DESC, until_at DESC, reason DESC))[1] AS reason
 FROM sources GROUP BY new_key
)
INSERT INTO motai.channel_cooldowns(cooldown_key,until_at,reason,observed_at)
SELECT new_key,until_at,reason,observed_at FROM merged
ON CONFLICT(cooldown_key) DO UPDATE SET until_at=excluded.until_at,
 reason=excluded.reason,observed_at=excluded.observed_at;

INSERT INTO motai.schema_migrations(version) VALUES(10) ON CONFLICT DO NOTHING;
