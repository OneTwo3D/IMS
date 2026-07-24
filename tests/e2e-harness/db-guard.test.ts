import assert from 'node:assert/strict'
import test from 'node:test'

import { assertE2eDatabase, databaseNameFromUrl, E2E_DATABASE_NAME } from '../../e2e/full-chain/harness/db-guard.ts'

function withDatabaseUrl(url: string | undefined, fn: () => void): void {
  const prev = process.env.DATABASE_URL
  try {
    if (url === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = url
    fn()
  } finally {
    if (prev === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = prev
  }
}

test('the e2e database is accepted', () => {
  withDatabaseUrl(`postgresql://ims:pw@127.0.0.1:5432/${E2E_DATABASE_NAME}`, () => {
    assert.doesNotThrow(() => assertE2eDatabase('fixture'))
  })
})

test('every non-e2e database is REJECTED, including ones a denylist would miss', () => {
  // The point of the positive allowlist: the old guard only knew about stage, so everything here except the
  // first entry would have sailed straight through into a destructive delete.
  const rejected = [
    'postgresql://ims:pw@127.0.0.1:5432/onetwo3d_ims_dev',        // stage — the only one a denylist caught
    'postgresql://ims:pw@127.0.0.1:5432/onetwo3d_ims',            // production
    'postgresql://ims:pw@127.0.0.1:5432/onetwo3d_ims_e2e_backup', // substring match, different database
    'postgresql://ims:pw@127.0.0.1:5432/onetwo3d_ims_e2e2',       // typo/clone
    `postgresql://ims:pw@${E2E_DATABASE_NAME}.example.com:5432/prod`, // name in the HOST, not the database
    `postgresql://ims:${E2E_DATABASE_NAME}@127.0.0.1:5432/prod`,      // name in the PASSWORD
    'postgresql://ims:pw@127.0.0.1:5432/',                        // no database at all
    'not a url',                                                  // unparseable — fails closed
  ]
  for (const url of rejected) {
    withDatabaseUrl(url, () => {
      assert.throws(
        () => assertE2eDatabase('fixture'),
        /ABORT: fixture refuses to run/,
        `expected ${url} to be rejected`,
      )
    })
  }
})

test('a missing DATABASE_URL fails closed', () => {
  withDatabaseUrl(undefined, () => {
    assert.throws(() => assertE2eDatabase('fixture'), /missing or unparseable/)
  })
})

test('databaseNameFromUrl parses the database name and decodes it', () => {
  assert.equal(databaseNameFromUrl('postgresql://u:p@h:5432/some_db'), 'some_db')
  assert.equal(databaseNameFromUrl('postgresql://u:p@h:5432/a%20b'), 'a b')
  assert.equal(databaseNameFromUrl(''), '')
  assert.equal(databaseNameFromUrl(null), '')
})
