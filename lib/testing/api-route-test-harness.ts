import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

import { apiRouteAuthPolicy, type ApiRouteAccess, type ApiRoutePath } from '@/lib/security/route-auth-policy'

type EnvPatch = Record<string, string | undefined>

export function assertRouteAccess(route: ApiRoutePath, expectedAccess: ApiRouteAccess): void {
  assert.equal(apiRouteAuthPolicy[route].access, expectedAccess, `${route} policy access changed`)
}

export function apiRouteRequest(pathname: string, init: RequestInit = {}): Request {
  return new Request(`http://ims.test${pathname}`, init)
}

export function nextApiRouteRequest(pathname: string, init: ConstructorParameters<typeof NextRequest>[1] = {}): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, init)
}

export async function expectStatus(
  label: string,
  responseOrPromise: Response | Promise<Response>,
  expectedStatus: number,
): Promise<Response> {
  const response = await responseOrPromise
  assert.equal(response.status, expectedStatus, `${label} expected HTTP ${expectedStatus}`)
  return response
}

export async function withRouteEnv<T>(patch: EnvPatch, run: () => Promise<T>): Promise<T> {
  const mutableEnv = process.env as Record<string, string | undefined>
  const previous = Object.fromEntries(
    Object.keys(patch).map((key) => [key, mutableEnv[key]]),
  ) as EnvPatch

  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = value
      }
    }

    return await run()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete mutableEnv[key]
      } else {
        mutableEnv[key] = value
      }
    }
  }
}
