import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * STATIC CHECK OVER THE PROJECTION SQL: a function that RETURNS jsonb must build its result from explicitly typed fields, never hand back (all or part of) its
 * input. It reads the migration and flags, per jsonb-returning function and for each of its parameters (and the usual row aliases):
 *   - a CASE branch that yields the input (`THEN p`, `ELSE p`) or a sub-object of it (`THEN p->'x'`);
 *   - a merge with the input (`|| p`, `p ||`), a removal from it (`p - 'key'`, `p #- ...`) or an overwrite of it (`jsonb_set(p, ...)`);
 *   - a bare `RETURN p`.
 * The only exceptions are listed here with the exact number of hits and the reason; a new pass-through fails this test until someone writes down why.
 */
const dir = new URL('../prisma/migrations/', import.meta.url)
const name = readdirSync(dir).find((n) => n.endsWith('_erasure_raw_payload_projection'))
assert.ok(name, 'the migration exists')
const sql = readFileSync(new URL(`${name}/migration.sql`, dir), 'utf8').replace(/--[^\n]*/g, '')

const ALIASES = ['l', 't', 'e', 'm', 'x', 'c', 'a']
const ALLOWED_PASS_THROUGH: Record<string, { hits: number; why: string }> = {
  gdpr_project_sync_log_payload: { hits: 1, why: 'the held-invoice park is returned as it is: the erasure\'s contact-block step (scrubHeldInvoicePayloads) owns that family' },
  gdpr_jsonb_maybe: { hits: 1, why: 'a PARSER: it returns the parsed input to a projection function, which then reads typed fields out of it and never returns it' },
}

function jsonbFunctions(): Array<{ fn: string; params: string[]; body: string }> {
  const out: Array<{ fn: string; params: string[]; body: string }> = []
  for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(([^)]*)\)\s+RETURNS jsonb[\s\S]*?\n\$\$;/g)) {
    const params = m[2]!.split(',').map((p) => p.trim().split(/\s+/)[0]!).filter((p) => p && p !== 'DEFAULT')
    out.push({ fn: m[1]!, params, body: m[0] })
  }
  return out
}

export function passThroughHits(body: string, names: string[]): string[] {
  const hits: string[] = []
  for (const n of names) {
    const id = `\\b${n}\\b`
    const patterns = [
      new RegExp(`\\b(?:THEN|ELSE)\\s+${n}(?![\\w(])(?!\\s*(?:->>|#>>))`, 'g'),
      new RegExp(`\\b(?:THEN|ELSE)\\s+${n}\\s*->(?!>)`, 'g'),
      new RegExp(`\\|\\|\\s*${n}(?![\\w(.>-])`, 'g'),
      new RegExp(`${id}\\s*\\|\\|`, 'g'),
      new RegExp(`jsonb_set\\(\\s*${n}\\b`, 'g'),
      new RegExp(`${id}\\s*#-`, 'g'),
      new RegExp(`${id}\\s+-\\s+'`, 'g'),
      new RegExp(`RETURN\\s+${n}\\s*;`, 'g'),
    ]
    for (const re of patterns) for (const h of body.matchAll(re)) hits.push(h[0])
  }
  return hits
}

test('no projection function returns an input object, sub-object or remainder (outside the two listed exceptions)', () => {
  const fns = jsonbFunctions()
  assert.ok(fns.length >= 25, `PRECONDITION: the scan found the projection functions (${fns.length})`)
  const unexpected: string[] = []
  for (const { fn, params, body } of fns) {
    const hits = passThroughHits(body, [...params, ...ALIASES])
    const allowed = ALLOWED_PASS_THROUGH[fn]?.hits ?? 0
    if (hits.length !== allowed) unexpected.push(`${fn}: ${hits.length} pass-through hit(s), ${allowed} allowed: ${hits.join(' | ')}`)
  }
  assert.deepEqual(unexpected, [])
  for (const fn of Object.keys(ALLOWED_PASS_THROUGH)) assert.ok(fns.some((f) => f.fn === fn), `the allowlisted ${fn} still exists`)
})

test('the scanner itself flags each pass-through shape (it is not vacuous)', () => {
  for (const bad of ['SELECT CASE WHEN x THEN p ELSE 1 END', 'SELECT CASE WHEN x THEN 1 ELSE p END', "SELECT CASE WHEN x THEN p->'order' END", 'SELECT a || p', 'SELECT p || a', "SELECT jsonb_set(p, '{a}', b)", "SELECT p #- '{a}'", "SELECT p - 'a'", 'RETURN p;']) {
    assert.ok(passThroughHits(bad, ['p']).length >= 1, `flags: ${bad}`)
  }
  for (const good of ["SELECT to_jsonb(p->>'a')", "SELECT jsonb_build_object('a', gdpr_token(p->'a'))", "SELECT CASE WHEN p ? 'a' THEN gdpr_token(p->'a') END", "SELECT CASE WHEN p->>'a' = 'x' THEN 1 END"]) {
    assert.equal(passThroughHits(good, ['p']).length, 0, `does not flag: ${good}`)
  }
})
