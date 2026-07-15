// Credentials the e2e seed (prepare.ts) creates and the specs log in with.
//
// The defaults are throwaway and intentionally weak — fine for a loopback-only
// local run. They are NOT fine for any instance reachable beyond the host: the
// full-chain rig (o3d-lgo) fronts an IMS with a public hostname so Xero's OAuth
// redirect can reach it, and a known-password admin on a public origin is a real
// account takeover. Override via E2E_ADMIN_PASSWORD / E2E_SUPPLIER_PASSWORD there.
//
// This module loads dotenv ITSELF rather than relying on its importers to have
// done so. ESM imports are hoisted and evaluated before the importing module's
// body runs, so prepare.ts's own loadDotenv() calls land AFTER this file has
// already read process.env — an override set only in .env would silently resolve
// to the weak default and the seed would still report success. (playwright.config.ts
// happens to load dotenv before importing specs, so only the standalone
// `tsx e2e/prepare.ts` path was affected — which is exactly the seed that writes
// the password.) override:false keeps real environment variables winning.
import { config as loadDotenv } from 'dotenv'

loadDotenv({ path: '.env.local', override: false })
loadDotenv({ path: '.env', override: false })

export const E2E_ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com'
export const E2E_ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'changeme123'
export const E2E_SUPPLIER_EMAIL = process.env.E2E_SUPPLIER_EMAIL ?? 'supplier@example.com'
export const E2E_SUPPLIER_PASSWORD = process.env.E2E_SUPPLIER_PASSWORD ?? 'changeme123'
export const E2E_SUPPLIER_ID = process.env.E2E_SUPPLIER_ID ?? 'e2e-supplier'
