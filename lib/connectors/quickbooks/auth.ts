import { notImplementedResult } from '@/lib/connectors/not-implemented'

const CONNECTOR = 'QuickBooks'

export async function getAuthorizationUrl() {
  return notImplementedResult('OAuth authorization', CONNECTOR)
}

export async function exchangeCodeForTokens() {
  return notImplementedResult('OAuth token exchange', CONNECTOR)
}

export async function disconnect() {
  return notImplementedResult('disconnect', CONNECTOR)
}

export async function isConnected() {
  return { connected: false as const }
}
