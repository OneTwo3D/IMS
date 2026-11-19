-- THE SQL TWIN OF lib/domain/crm/identity-key.ts `looseIdentityEmail`, as one IMMUTABLE function so the resolver query and the index below share ONE
-- definition. It finds CANDIDATES for the cluster resolver; every candidate is re-filtered in TypeScript (which also rejects placeholder addresses).
--
--   1. normalize(..., NFC)                       Unicode composition, as String.prototype.normalize('NFC')
--   2. trim of EVERY JavaScript white-space      \t \n \v \f \r, space, NBSP, U+1680, U+2000-200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF
--      character (the class below equals JS trim() and \s)
--   3. lower() COLLATE "C"                       ASCII-only and byte-deterministic whatever the database locale (the TypeScript fold lower-cases ASCII only)
--   4. NULL for an address with internal white space, or not exactly one '@' with text on both sides
--   5. the +tag dropped from the local part; for gmail.com / googlemail.com also the dots, and the domain folded to gmail.com
--
-- ADDITIVE ONLY: a new function. If this body ever changes, the index built on it (customers_loose_identity_key_v2_idx) MUST be rebuilt in the same migration:
-- an immutable function whose body changed leaves the old index entries wrong.
-- prisma-schema-scope-ok: SQL function | reason: Prisma cannot represent functions

CREATE OR REPLACE FUNCTION crm_loose_identity_key(email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $fn$
  SELECT CASE
    WHEN t = '' OR t ~ '[\t\n\v\f\r    -     　﻿]' OR t !~ '^[^@]+@[^@]+$' THEN NULL
    WHEN split_part(t, '@', 2) IN ('gmail.com', 'googlemail.com') THEN
      CASE WHEN replace(split_part(split_part(t, '@', 1), '+', 1), '.', '') = '' THEN NULL
           ELSE replace(split_part(split_part(t, '@', 1), '+', 1), '.', '') || '@gmail.com' END
    WHEN split_part(split_part(t, '@', 1), '+', 1) = '' THEN NULL
    ELSE split_part(split_part(t, '@', 1), '+', 1) || '@' || split_part(t, '@', 2)
  END
  FROM (SELECT lower(regexp_replace(normalize(email, NFC), '^[\t\n\v\f\r    -     　﻿]+|[\t\n\v\f\r    -     　﻿]+$', '', 'g') COLLATE "C") AS t) s
$fn$;
