-- HOTFIX: crm_loose_identity_key (migration 20261119140100) on a NON-UTF8 database.
--
-- The function calls normalize(email, NFC), which PostgreSQL refuses unless server_encoding is UTF8 ("Unicode normalization can only be performed if server
-- encoding is UTF8"), and its white-space class holds multi-byte characters (NBSP, U+2000-200A, U+3000, ...). On a byte encoding such as SQL_ASCII those are
-- BYTES, so the class can match single bytes inside a valid non-ASCII address. Stage is SQL_ASCII with collation C, so 20261119140200 (the CREATE INDEX on the
-- function) fails there, and every runtime query that uses the function would fail too.
--
-- THIS MIGRATION'S TIMESTAMP SITS BETWEEN 140100 AND 140200 ON PURPOSE: on a database where 140200 failed and was resolved as rolled back, this applies first
-- (Prisma applies out-of-order pending migrations), so the retried 140200 builds its index on the encoding-safe body.
--
--   * server_encoding <> 'UTF8': replace the function with a body that has no normalize() and a white-space class of ASCII \t \n \v \f \r and space only
--     (no multi-byte characters in a regex class on a byte encoding). Same signature and attributes (IMMUTABLE PARALLEL SAFE STRICT, LANGUAGE sql).
--   * UTF8 (every database that matters, production included): NOTHING CHANGES. In particular, where 140200 already ran, the body of the function under
--     customers_loose_identity_key_v2_idx is not touched: an immutable function whose body changes would leave the index entries wrong.
--
-- KNOWN LIMIT, ACCEPTED: the TypeScript fold (lib/domain/crm/identity-key.ts) still does NFC and trims every Unicode white-space character. On a non-UTF8
-- database the SQL key therefore equals the TypeScript key for ASCII addresses ONLY; a non-ASCII address may fold differently. That is acceptable because
-- production must be UTF8 (the installer is tracked separately to create the database as UTF8).
--
-- ADDITIVE ONLY: replaces a function body on non-UTF8 databases, creates nothing else.
-- prisma-schema-scope-ok: SQL function | reason: Prisma cannot represent functions

DO $migration$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    CREATE OR REPLACE FUNCTION crm_loose_identity_key(email text)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    STRICT
    AS $fn$
      SELECT CASE
        WHEN t = '' OR t ~ '[\t\n\v\f\r ]' OR t !~ '^[^@]+@[^@]+$' THEN NULL
        WHEN split_part(t, '@', 2) IN ('gmail.com', 'googlemail.com') THEN
          CASE WHEN replace(split_part(split_part(t, '@', 1), '+', 1), '.', '') = '' THEN NULL
               ELSE replace(split_part(split_part(t, '@', 1), '+', 1), '.', '') || '@gmail.com' END
        WHEN split_part(split_part(t, '@', 1), '+', 1) = '' THEN NULL
        ELSE split_part(split_part(t, '@', 1), '+', 1) || '@' || split_part(t, '@', 2)
      END
      FROM (SELECT lower(regexp_replace(email, '^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$', '', 'g') COLLATE "C") AS t) s
    $fn$;
  END IF;
END
$migration$;
