import assert from 'node:assert/strict'
import test from 'node:test'

import { dataCollection } from '@/lib/observability/data-collection'
import { dropContentCapturingIntegrations } from '@/lib/observability/integrations'

test('dataCollection turns off every content-capturing option explicitly', () => {
  assert.deepEqual(dataCollection.genAI, { inputs: false, outputs: false })
  assert.deepEqual(dataCollection.mcp, { inputs: false, outputs: false })
  assert.deepEqual(dataCollection.graphQL, { document: false, variables: false })
  assert.equal(dataCollection.userInfo, false)
  assert.equal(dataCollection.cookies, false)
  assert.equal(dataCollection.urlQueryParams, false)
  assert.deepEqual(dataCollection.httpBodies, [])
  assert.equal(dataCollection.databaseQueryData, false)
  assert.equal(dataCollection.queues, false)
  assert.equal(dataCollection.stackFrameVariables, false)
  // headers are an allowlist, never a deny list or "collect all"
  const req = dataCollection.httpHeaders.request
  assert.ok('allow' in req)
  for (const h of req.allow) assert.doesNotMatch(h, /auth|cookie|signature|token|key/i)
  assert.ok(!req.allow.includes('referer'))
})

test('content-capturing default integrations are dropped, error integrations kept', () => {
  const names = ['Dedupe', 'LinkedErrors', 'Http', 'Console', 'OpenAI', 'Anthropic_AI', 'Google_GenAI', 'VercelAI', 'LangChain', 'McpServer', 'Postgres', 'Prisma']
  const kept = dropContentCapturingIntegrations(names.map((name) => ({ name }))).map((i) => i.name)
  assert.deepEqual(kept, ['Dedupe', 'LinkedErrors', 'Http', 'Postgres', 'Prisma'])
})
