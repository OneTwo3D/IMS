import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

/**
 * The numbering settings are `settings.company` and nothing else. The REAL requirePermission/hasPermission decide;
 * only the session source and the database are replaced. A refused call must not reach the database at all, and the
 * database stand-in is proved to be wired (an ADMIN call reaches it), so "no touch" is observed and not assumed.
 */

type Role = 'ADMIN' | 'MANAGER' | 'WAREHOUSE' | 'FINANCE' | 'READONLY' | 'SUPPLIER'
let currentRole: Role = 'ADMIN'
const touches: string[] = []

mock.module('@/lib/auth', {
  namedExports: { auth: async () => ({ user: { id: 'u1', email: 'u@example.test', name: 'U', role: currentRole } }) },
})
mock.module('@/lib/db', {
  namedExports: {
    db: new Proxy({}, {
      get: (_target, key) => {
        touches.push(String(key))
        return () => { throw new Error(`db.${String(key)} reached`) }
      },
    }),
  },
})
mock.module('next/cache', { namedExports: { revalidatePath: () => {} } })

const ACTIONS = ['getDocumentNumbering', 'previewDocumentPattern', 'saveDocumentNumberPattern', 'resetDocumentNumberCounter'] as const
const input = { type: 'purchase_order', pattern: 'PO-{SEQ}', nextNumber: 5 }

async function call(name: (typeof ACTIONS)[number]) {
  const actions = await import('@/app/actions/document-numbering')
  return (actions[name] as (i: typeof input) => Promise<unknown>)(input)
}

for (const role of ['MANAGER', 'WAREHOUSE', 'FINANCE', 'READONLY', 'SUPPLIER'] as const) {
  for (const name of ACTIONS) {
    test(`${name} refuses a ${role} session, naming settings.company, before touching the database`, async () => {
      currentRole = role
      touches.length = 0
      await assert.rejects(() => call(name), (error: unknown) => {
        assert.equal((error as { permission?: string }).permission, 'settings.company')
        assert.match((error as Error).message, /Forbidden: missing permission settings\.company/)
        return true
      })
      assert.deepEqual(touches, [], `${role} calling ${name}`)
    })
  }
}

test('an ADMIN session gets past the guard and reaches the database (so the refusals above are not vacuous)', async () => {
  currentRole = 'ADMIN'
  for (const name of ACTIONS) {
    touches.length = 0
    await assert.rejects(() => call(name), (error: unknown) => !/Forbidden/.test((error as Error).message), name)
    assert.ok(touches.length > 0, `${name} reached the database for ADMIN`)
  }
})

test('every export of the numbering action module is an async server action behind requirePermission(settings.company)', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../../app/actions/document-numbering.ts', import.meta.url), 'utf8')
  assert.match(source, /^'use server'/)
  const exported = [...source.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!)
  assert.deepEqual([...exported].sort(), [...ACTIONS].sort())
  for (const name of ACTIONS) {
    const body = source.slice(source.indexOf(`export async function ${name}`))
    const firstAwait = body.indexOf('await ')
    assert.ok(body.slice(firstAwait, firstAwait + 60).includes("requirePermission('settings.company')"), `${name} guards first`)
  }
})
