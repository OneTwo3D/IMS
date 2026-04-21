import { getMintsoftAccessToken, getMintsoftApiConfiguration, invalidateMintsoftAccessToken } from './auth'
import type { WmsStockLine, WmsWarehouseRef } from '@/lib/connectors/wms/types'
import {
  extractMintsoftArrayPayload,
  normalizeMintsoftStockLine,
  normalizeMintsoftWarehouse,
} from './normalizers'

type MintsoftRequestResult<T> = {
  data: T | null
  error?: string
  status: number
}

function buildMintsoftRequestUrl(path: string, baseUrl: string): URL {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  const normalizedPath = path.replace(/^\/+/, '')
  return new URL(normalizedPath, normalizedBaseUrl)
}

async function sendMintsoftRequest<T>(
  path: string,
  baseUrl: string,
  apiKey: string,
  init: RequestInit | undefined,
): Promise<MintsoftRequestResult<T>> {
  const response = await fetch(buildMintsoftRequestUrl(path, baseUrl), {
    ...init,
    headers: {
      Accept: 'application/json',
      'ms-apikey': apiKey,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
    cache: 'no-store',
  })

  if (!response.ok) {
    return {
      data: null,
      error: `Mintsoft request failed with status ${response.status}`,
      status: response.status,
    }
  }

  if (response.status === 204) {
    return {
      data: null,
      status: response.status,
    }
  }

  return {
    data: (await response.json()) as T,
    status: response.status,
  }
}

export async function mintsoftRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<MintsoftRequestResult<T>> {
  const config = await getMintsoftApiConfiguration()
  if (!config.baseUrl) {
    return {
      data: null,
      error: 'Mintsoft connection is not configured',
      status: 400,
    }
  }

  try {
    const apiKey = await getMintsoftAccessToken()
    const firstAttempt = await sendMintsoftRequest<T>(path, config.baseUrl, apiKey, init)
    if (firstAttempt.status !== 401) {
      return firstAttempt
    }

    await invalidateMintsoftAccessToken()
    const refreshedApiKey = await getMintsoftAccessToken({ forceRefresh: true })
    return sendMintsoftRequest<T>(path, config.baseUrl, refreshedApiKey, init)
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error.message : 'Mintsoft request failed',
      status: 500,
    }
  }
}

export async function fetchMintsoftWarehouses(): Promise<WmsWarehouseRef[]> {
  const result = await mintsoftRequest<unknown>('/api/Warehouse')
  if (result.error) {
    throw new Error(result.error)
  }

  return extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftWarehouse(item))
    .filter((item): item is WmsWarehouseRef => Boolean(item))
}

export async function fetchMintsoftStockLevels(externalWarehouseId: string): Promise<WmsStockLine[]> {
  const query = new URLSearchParams({ WarehouseId: externalWarehouseId.trim() })
  const result = await mintsoftRequest<unknown>(`/api/Product/StockLevels?${query.toString()}`)
  if (result.error) {
    throw new Error(result.error)
  }

  return extractMintsoftArrayPayload(result.data)
    .map((item) => normalizeMintsoftStockLine(item))
    .filter((item): item is WmsStockLine => Boolean(item))
}
