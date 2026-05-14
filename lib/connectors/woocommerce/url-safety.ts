import { validateExternalBaseUrl } from '@/lib/security/external-url-safety'

export function validateWooCommerceBaseUrl(rawUrl: string): { ok: true; normalizedUrl: string } | { ok: false; error: string } {
  return validateExternalBaseUrl(rawUrl, {
    connectorName: 'WooCommerce',
    allowE2eLocalHttp: true,
  })
}
