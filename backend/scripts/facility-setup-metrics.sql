-- Run with psql -v installation_id=... on an authorized pilot reporting connection.
-- Return aggregate counts. Completed manual setups are included in the median.
WITH completed AS (
  SELECT DISTINCT installation_id, (scope->'testedProfile'->>'draftId')::uuid AS draft_id
  FROM record_order_sessions
  WHERE installation_id = :'installation_id' AND decided_at IS NOT NULL
    AND state IN ('active','superseded') AND scope->'testedProfile'->>'draftId' IS NOT NULL
), per_setup AS (
  SELECT c.installation_id, c.draft_id, count(r.digest) AS calls, coalesce(sum(r.tokens),0) AS tokens,
    coalesce(sum((r.result->>'costMicrousd')::numeric),0) AS known_cost,
    count(*) FILTER (WHERE r.digest IS NOT NULL AND r.result->>'costMicrousd' IS NULL) AS unpriced_calls
  FROM completed c LEFT JOIN record_setup_requests r USING (installation_id,draft_id)
  GROUP BY c.installation_id,c.draft_id
), reviewed AS (
  SELECT count(*) AS reviewed, count(*) FILTER (WHERE review.value = 'accepted') AS accepted
  FROM completed c JOIN record_setup_requests r USING (installation_id,draft_id)
  CROSS JOIN LATERAL jsonb_each_text(coalesce(r.result->'reviews','{}'::jsonb)) AS review
)
SELECT count(*) AS completed_setups, sum(calls) AS setup_requests,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY calls) AS median_setup_calls,
  sum(tokens) AS reported_tokens, sum(unpriced_calls) AS unpriced_requests,
  CASE WHEN sum(unpriced_calls)=0 THEN round(avg(known_cost)/1000000,6) END AS mean_estimated_usd_per_setup,
  (SELECT reviewed FROM reviewed) AS suggestions_reviewed, (SELECT accepted FROM reviewed) AS suggestions_accepted,
  (SELECT round(accepted::numeric/nullif(reviewed,0),4) FROM reviewed) AS acceptance_rate
FROM per_setup;
