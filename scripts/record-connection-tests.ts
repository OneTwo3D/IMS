/**
 * Record the Woo + Xero "Test Connection" results on this instance.
 *
 * XERO is GATED: triggerXeroSync calls assertIntegrationConnectionTestPassed('xero',
 * …) (app/actions/xero-sync.ts:82), so without a PASSING record whose fingerprint
 * still matches the current credentials, sync refuses. WooCommerce is NOT gated —
 * only 'xero' and 'smtp' are — but its result is recorded and surfaced in the UI, so
 * it is worth having and worth being true.
 *
 * The UI buttons are server actions behind requireAdmin(), which a script has no
 * session for — hence this equivalent.
 *
 *   NODE_OPTIONS='--import tsx' node --env-file=.env scripts/record-connection-tests.ts
 *
 * It performs the SAME checks the actions perform and reuses the SAME exported
 * helpers (buildIntegrationConnectionFingerprint / recordIntegrationConnectionTest /
 * integrationConnectionFingerprintSecret) rather than reimplementing the fingerprint.
 * That matters: a hand-rolled copy would drift from the real algorithm and the gate
 * would then fail with a confusing "credentials changed since the last test".
 *
 * It does NOT fabricate a pass. Each connector is genuinely called, and a failure is
 * recorded as a failure.
 */
import {
  buildIntegrationConnectionFingerprint,
  integrationConnectionFingerprintSecret,
  recordIntegrationConnectionTest,
} from '../lib/integration-connection-test-gate.ts'
import { buildWooCommerceConnectionFingerprint } from '../lib/connectors/woocommerce/connection-test-gate.ts'
import { getSettingValue, getSettingValues } from '../lib/settings-store.ts'
import { getBaseCurrencyCode } from '../lib/base-currency.ts'
import { xeroGet } from '../lib/connectors/xero/api.ts'
import { db } from '../lib/db/index.ts'

async function testXero(): Promise<boolean> {
  const [clientId, clientSecret, expectedTenantId, token] = await Promise.all([
    getSettingValue('xero_client_id'),
    getSettingValue('xero_client_secret'),
    getSettingValue('xero_expected_tenant_id'),
    db.accountingToken.findUnique({ where: { connector: 'xero' }, select: { tenantId: true, tenantName: true } }),
  ])
  const fingerprint = buildIntegrationConnectionFingerprint({
    clientId: clientId ?? '',
    clientSecret: integrationConnectionFingerprintSecret(clientSecret ?? ''),
    expectedTenantId: expectedTenantId ?? '',
    tenantId: token?.tenantId ?? '',
    tenantName: token?.tenantName ?? '',
  })

  const [imsBaseCurrency, orgRes] = await Promise.all([
    getBaseCurrencyCode(),
    xeroGet<{ Organisations?: Array<{ Name?: string; BaseCurrency?: string }> }>('Organisation'),
  ])
  const organisation = (orgRes.data?.Organisations ?? [])[0]
  const xeroBaseCurrency = organisation?.BaseCurrency?.toUpperCase() ?? null

  let success = false
  let message: string
  if (!orgRes.ok || !xeroBaseCurrency) {
    message = 'Cannot verify Xero because the connected organisation base currency could not be determined.'
  } else if (xeroBaseCurrency !== imsBaseCurrency) {
    message = `Xero organisation base currency (${xeroBaseCurrency}) does not match the IMS base currency (${imsBaseCurrency}).`
  } else {
    success = true
    message = `Connection verified against Xero${organisation?.Name ? ` (${organisation.Name})` : ''}.`
  }

  await recordIntegrationConnectionTest('xero', { success, fingerprint, message })
  console.log(`xero: ${success ? 'PASS' : 'FAIL'} — ${message}`)
  return success
}

async function testWoo(): Promise<boolean> {
  const s = await getSettingValues(['wc_url', 'wc_consumer_key', 'wc_consumer_secret'])
  const url = s.get('wc_url') ?? ''
  const key = s.get('wc_consumer_key') ?? ''
  const secret = s.get('wc_consumer_secret') ?? ''
  // Use the connector's OWN builder — its field names (url/key/secret) are part of
  // the hash, so an invented shape would produce a fingerprint that never matches
  // what the UI later computes.
  const fingerprint = buildWooCommerceConnectionFingerprint({ url, key, secret })

  let success = false
  let message: string
  try {
    const auth = Buffer.from(`${key}:${secret}`).toString('base64')
    const res = await fetch(`${url.replace(/\/$/, '')}/wp-json/wc/v3/settings/general/woocommerce_currency`, {
      headers: { Authorization: `Basic ${auth}` },
    })
    if (!res.ok) {
      message = `WooCommerce responded ${res.status} ${res.statusText}.`
    } else {
      const body = (await res.json()) as { value?: string }
      const imsBase = await getBaseCurrencyCode()
      const wcCurrency = (body.value ?? '').toUpperCase()
      if (wcCurrency && wcCurrency !== imsBase) {
        message = `WooCommerce store currency (${wcCurrency}) does not match the IMS base currency (${imsBase}).`
      } else {
        success = true
        message = `Connection verified against WooCommerce (${url}), currency ${wcCurrency || 'unknown'}.`
      }
    }
  } catch (e) {
    message = `WooCommerce request failed: ${e instanceof Error ? e.message : String(e)}`
  }

  await recordIntegrationConnectionTest('woocommerce', { success, fingerprint, message })
  console.log(`woocommerce: ${success ? 'PASS' : 'FAIL'} — ${message}`)
  return success
}

async function main() {
  if ((process.env.DATABASE_URL ?? '').includes('onetwo3d_ims_dev')) {
    throw new Error('ABORT: DATABASE_URL points at the STAGE database. Run this on the e2e instance.')
  }
  const xero = await testXero()
  const woo = await testWoo()
  if (!xero || !woo) {
    console.error('\nAt least one connector failed — recorded as a FAILURE, not papered over.')
    process.exit(1)
  }
  console.log('\nBoth connectors verified and recorded.')
}

main()
  .then(() => db.$disconnect())
  .catch(async (e) => {
    console.error(`\n${e instanceof Error ? e.message : e}`)
    await db.$disconnect()
    process.exit(1)
  })
