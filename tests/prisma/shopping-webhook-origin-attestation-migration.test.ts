import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  WEBHOOK_ORIGIN_LEGACY_WRITER,
  WEBHOOK_ORIGIN_PRE_ATTESTATION,
  attestedOrigin,
} from '@/lib/connectors/webhook-origin'

const MIGRATION = 'prisma/migrations/20260820090000_shopping_webhook_event_origin_attestation/migration.sql'
const SCHEMA = 'prisma/schema.prisma'

/**
 * o3d-wgl6 finding 1: the deploy window.
 *
 * Migrations run against the live database BEFORE the new build replaces the old one, and the
 * old build keeps accepting webhooks throughout. Its INSERT names no `originAttestation`, so a
 * NOT NULL column with no default rejects every delivery received during the deploy — and
 * WooCommerce responds to a run of 500s by disabling the webhook at the store end.
 */

test('the NOT NULL attestation column keeps a DEFAULT, so the pre-deploy build can still insert', () => {
  const sql = readFileSync(MIGRATION, 'utf8')

  assert.match(sql, /ADD COLUMN\s+"originAttestation"\s+TEXT\s+NOT NULL\s+DEFAULT\s+'unproven:pre-attestation'/i)
  assert.doesNotMatch(
    sql,
    /ALTER COLUMN\s+"originAttestation"\s+DROP DEFAULT/i,
    'dropping the default makes every INSERT from the still-running previous build fail NOT NULL',
  )
  assert.match(sql, /ALTER COLUMN\s+"originAttestation"\s+SET DEFAULT\s+'unproven:legacy-writer'/i)
})

test('the deploy-window default is a DIFFERENT marker from the backfill, so the two eras stay apart', () => {
  const sql = readFileSync(MIGRATION, 'utf8')

  // The backfill states "this row predates the column"; the standing default states "the
  // column existed and the writer named nothing". Collapsing them back into one value is the
  // o3d-t74p leniency the NOT NULL was for in the first place.
  assert.notEqual(WEBHOOK_ORIGIN_LEGACY_WRITER, WEBHOOK_ORIGIN_PRE_ATTESTATION)
  const backfill = sql.match(/ADD COLUMN\s+"originAttestation"\s+TEXT\s+NOT NULL\s+DEFAULT\s+'([^']+)'/i)?.[1]
  const standing = sql.match(/ALTER COLUMN\s+"originAttestation"\s+SET DEFAULT\s+'([^']+)'/i)?.[1]
  assert.equal(backfill, WEBHOOK_ORIGIN_PRE_ATTESTATION)
  assert.equal(standing, WEBHOOK_ORIGIN_LEGACY_WRITER)
  assert.notEqual(standing, backfill)
})

test('neither default can be mistaken for a proven origin', () => {
  // Whatever a row falls back to, it must never read as "this delivery named a store".
  assert.equal(attestedOrigin(WEBHOOK_ORIGIN_PRE_ATTESTATION), null)
  assert.equal(attestedOrigin(WEBHOOK_ORIGIN_LEGACY_WRITER), null)
  assert.ok(WEBHOOK_ORIGIN_LEGACY_WRITER.startsWith('unproven:'))
})

test('the Prisma model carries the same standing default, so the schema does not drift from the DB', () => {
  const schema = readFileSync(SCHEMA, 'utf8')
  assert.match(schema, /originAttestation\s+String\s+@default\("unproven:legacy-writer"\)/)
})
