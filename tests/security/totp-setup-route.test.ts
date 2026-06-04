import assert from 'node:assert/strict'
import test from 'node:test'

import { handleTotpSetupGet } from '../../app/api/auth/totp-setup/route.ts'
import type { AuthSession } from '../../lib/auth/server.ts'

function session(): AuthSession {
  return {
    user: {
      id: 'user-1',
      email: 'admin@example.com',
      name: 'Admin',
      role: 'ADMIN',
      supplierId: null,
      totpEnabled: false,
      totpVerified: true,
    },
  }
}

test('TOTP setup response excludes the raw secret while staging it server-side', async () => {
  const stagedSecrets: Array<{ userId: string; secret: string }> = []

  const response = await handleTotpSetupGet({
    authorize: async () => session(),
    generateSecret: () => 'raw-totp-secret',
    generateUri: ({ secret, label, issuer }) => {
      assert.equal(secret, 'raw-totp-secret')
      assert.equal(label, 'admin@example.com')
      assert.equal(issuer, 'onetwoInventory')
      return 'otpauth://totp/onetwoInventory:admin@example.com?secret=raw-totp-secret'
    },
    generateQrDataUrl: async (input) => {
      assert.equal(input.includes('raw-totp-secret'), true)
      return 'data:image/png;base64,qr-code'
    },
    stageSecret: async (userId, secret) => {
      stagedSecrets.push({ userId, secret })
    },
  })

  const body = await response.json() as { qrDataUrl?: unknown; secret?: unknown }

  assert.equal(response.status, 200)
  assert.deepEqual(stagedSecrets, [{ userId: 'user-1', secret: 'raw-totp-secret' }])
  assert.deepEqual(body, { qrDataUrl: 'data:image/png;base64,qr-code' })
  assert.equal('secret' in body, false)
  assert.equal(JSON.stringify(body).includes('raw-totp-secret'), false)
})
