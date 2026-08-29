#!/usr/bin/env node

/**
 * o3d-1izw — DEPLOYMENT FAILS CLOSED WHEN THE DATABASE HAS NOT HEARD OF A STATE THIS BUILD WRITES.
 *
 * `scripts/deploy.sh` normally applies migrations and then runs check-prisma-drift, so an ordinary
 * deploy cannot leave the code ahead of the schema. `deploy.sh --skip-migrate` skips both, and so
 * does any environment served straight from a working tree by `next dev`. Those are the two ways
 * this branch reaches an environment ahead of its own schema, and this check is what makes the
 * first of them refuse instead of shipping a build whose first lapsed create claim fails at the
 * database and keeps failing on every later sweep.
 *
 * Deliberately narrow and cheap: one catalogue query, no Prisma engine, no migration state. It
 * answers the single question "can this build write what it is about to write?".
 *
 * The query is the SHARED, COLUMN-ANCHORED one — it starts at `wms_order_push_links.state` and
 * reads the labels of the type that column is actually declared as, never matching a type by name.
 * A name-keyed check is satisfied by any same-named enum anywhere in the database, and since all
 * three gates asked the same question, one wrong query was a common-mode bypass of all of them.
 */

import { config as loadDotenv } from 'dotenv'

import { establishStartupOptionByteSafety, nonAsciiStartupOptionCharacters } from '../lib/db/database-url-schema.mjs'
import {
  pgConnectionConfig,
  pinClientToMeasuredBackend,
  WMS_PUSH_STATE_COLUMN,
  WMS_PUSH_STATE_ENUM_LABELS_SQL,
  WMS_PUSH_STATE_TABLE,
} from '../lib/domain/wms/push-state-enum-query.mjs'

loadDotenv({ path: '.env.local', override: false, quiet: true })
loadDotenv({ path: '.env', override: false, quiet: true })

const ENUM = 'WmsOrderPushState'
const MIGRATION = '20260827090000_wms_push_ambiguous_create'
const REQUIRED = ['AMBIGUOUS_CREATE']

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  console.error(`FAIL ${ENUM}: DATABASE_URL is not set, so the database's enum vocabulary cannot be read.`)
  console.error('Refusing rather than assuming it is fine — see o3d-1izw.')
  process.exit(1)
}

// o3d-2k5r r19 — THE COMPATIBILITY QUESTION, ASKED BEFORE THE DEPLOY STOPS ANYTHING.
//
// `deploy.sh` runs this gate ahead of the stop and the migration, so it is the right place to
// settle whether this server can carry a non-ASCII schema name. Without it, a deployment whose
// URL names one would learn about the refusal from a service that failed to restart, after the
// predecessor was already down. A URL with no such bytes settles without opening a connection;
// where there are some, the verdict this leaves behind is what `pgConnectionConfig()` below
// consults, so the failure is reported here with the rename procedure attached.
if (nonAsciiStartupOptionCharacters(databaseUrl) !== '') {
  await establishStartupOptionByteSafety(databaseUrl)
}

const { Client } = await import('pg')
// Prisma reads `?schema=` from the URL and sets search_path from it; `pg` does not. The shared
// statement resolves the table through the asking connection's search path on purpose, so this
// out-of-process check aligns itself with the process it is vouching for.
// The spread comes FIRST and carries the connection string with it: `pg` parses
// `connectionString` after the surrounding config, so an `options=` left inside the URL would
// overwrite the search path composed beside it (o3d-2k5r r10).
// `pinClientToMeasuredBackend` wraps `connect()` so this gate cannot read its catalogue from a
// backend the deployment probe above is not about (o3d-2k5r r22). It is a no-op for an ASCII pin.
const clientConfig = {
  ...pgConnectionConfig(databaseUrl),
  connectionTimeoutMillis: 10_000,
}
const client = pinClientToMeasuredBackend(new Client(clientConfig), clientConfig)

let labels
try {
  await client.connect()
  const result = await client.query(WMS_PUSH_STATE_ENUM_LABELS_SQL, [WMS_PUSH_STATE_TABLE, WMS_PUSH_STATE_COLUMN])
  labels = result.rows.map((row) => row.enumlabel)
} catch (error) {
  console.error(`FAIL ${ENUM}: could not read the enum ${WMS_PUSH_STATE_TABLE}.${WMS_PUSH_STATE_COLUMN} is declared as (${error instanceof Error ? error.message : String(error)}).`)
  console.error('An unreadable catalogue is not a clean one — see o3d-1izw.')
  process.exit(1)
} finally {
  await client.end().catch(() => undefined)
}

const missing = REQUIRED.filter((value) => !labels.includes(value))
if (missing.length > 0) {
  console.error(`FAIL ${ENUM}: the type ${WMS_PUSH_STATE_TABLE}.${WMS_PUSH_STATE_COLUMN} is declared as is missing ${missing.join(', ')}.`)
  console.error('(Read from that column\'s own catalogue entry — a same-named enum elsewhere in the database does not count.)')
  console.error(`Migration ${MIGRATION} has not been applied here. The WMS order-push sweep will refuse to run`)
  console.error('until it is. Apply it with:')
  console.error('  npx prisma migrate deploy --schema prisma/schema.prisma')
  console.error('  node scripts/check-prisma-drift.mjs')
  console.error('Release gate: o3d-1izw.')
  process.exit(1)
}

console.log(`PASS ${ENUM}: ${REQUIRED.join(', ')} present on the type ${WMS_PUSH_STATE_TABLE}.${WMS_PUSH_STATE_COLUMN} is declared as.`)
