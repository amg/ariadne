-- A database restored from a snapshot fetches each block from S3 the first
-- time it is read, so the first minutes of a run would measure S3 instead
-- of the app. This reads every block of every table, index and TOAST
-- relation once, before load starts.
CREATE EXTENSION IF NOT EXISTS pg_prewarm;

SELECT n.nspname AS schema,
       sum(pg_prewarm(c.oid, 'read')) AS blocks_read
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'i', 't', 'm')
  AND c.relpersistence = 'p'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  -- Managed Postgres keeps the system catalogs' TOAST tables under its own
  -- admin role, so they are skipped; the app's own TOAST data is warmed.
  AND has_table_privilege(c.oid, 'SELECT')
GROUP BY n.nspname
ORDER BY n.nspname;
