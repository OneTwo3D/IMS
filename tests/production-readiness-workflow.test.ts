import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync('.github/workflows/production-readiness.yml', 'utf8')

test('production readiness classifier is event-aware for pull_request and push triggers', () => {
  assert.match(workflow, /github\.event_name[\s\S]*pull_request/)
  assert.match(workflow, /github\.event\.pull_request\.base\.sha/)
  assert.match(workflow, /github\.event\.pull_request\.head\.sha/)
  assert.match(workflow, /github\.event\.before/)
  assert.match(workflow, /github\.event\.after/)
})

test('production readiness push classifier falls back to expensive checks when diff bounds are unsafe', () => {
  assert.match(workflow, /0000000000000000000000000000000000000000/)
  assert.match(workflow, /\[ -z "\$base" \]/)
  assert.match(workflow, /\[ -z "\$head" \]/)
  assert.match(workflow, /if ! git diff --name-only "\$base" "\$head" > changed-files\.txt/)
  assert.match(workflow, /echo "run_expensive=true" >> "\$GITHUB_OUTPUT"/)
})

test('production readiness concurrency separates pull_request and push runs', () => {
  assert.match(
    workflow,
    /group: production-readiness-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name \}\}-\$\{\{ github\.ref \}\}/,
  )
})
