import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  deriveLifecycleStatusFromLegacyActive,
  deriveLifecycleStatusFromWooStatus,
  deriveWooStatusFromLifecycleStatus,
  isPurchasableProductStatus,
  isReorderEligibleProductStatus,
  isSellableProductStatus,
  shouldForceWooDraft,
  shouldForceWooZeroStock,
} from '@/lib/products/lifecycle'

test('product lifecycle helpers encode draft active eol archived workflow', () => {
  assert.equal(isSellableProductStatus('ACTIVE'), true)
  assert.equal(isSellableProductStatus('EOL'), true)
  assert.equal(isSellableProductStatus('DRAFT'), false)
  assert.equal(isSellableProductStatus('ARCHIVED'), false)

  assert.equal(isPurchasableProductStatus('ACTIVE'), true)
  assert.equal(isPurchasableProductStatus('DRAFT'), true)
  assert.equal(isPurchasableProductStatus('EOL'), false)
  assert.equal(isPurchasableProductStatus('ARCHIVED'), false)

  assert.equal(isReorderEligibleProductStatus('ACTIVE'), true)
  assert.equal(isReorderEligibleProductStatus('DRAFT'), true)
  assert.equal(isReorderEligibleProductStatus('EOL'), false)
  assert.equal(isReorderEligibleProductStatus('ARCHIVED'), false)
})

test('product lifecycle helpers map legacy and shopping statuses consistently', () => {
  assert.equal(deriveLifecycleStatusFromLegacyActive(true), 'ACTIVE')
  assert.equal(deriveLifecycleStatusFromLegacyActive(false), 'EOL')

  assert.equal(deriveLifecycleStatusFromWooStatus('publish'), 'ACTIVE')
  assert.equal(deriveLifecycleStatusFromWooStatus('draft'), 'DRAFT')
  assert.equal(deriveLifecycleStatusFromWooStatus('draft', 'EOL'), 'EOL')
  assert.equal(deriveLifecycleStatusFromWooStatus('draft', 'ARCHIVED'), 'ARCHIVED')

  assert.equal(deriveWooStatusFromLifecycleStatus('ACTIVE'), 'publish')
  assert.equal(deriveWooStatusFromLifecycleStatus('EOL'), 'publish')
  assert.equal(deriveWooStatusFromLifecycleStatus('DRAFT'), 'draft')
  assert.equal(deriveWooStatusFromLifecycleStatus('ARCHIVED'), 'draft')

  assert.equal(shouldForceWooDraft('DRAFT'), true)
  assert.equal(shouldForceWooDraft('EOL'), false)
  assert.equal(shouldForceWooZeroStock('ARCHIVED'), true)
})
