import type { WmsConnector, WmsConnectorId } from './types'
import { MintsoftConnector } from '@/lib/connectors/mintsoft'

export type WmsConnectorDef = {
  id: WmsConnectorId
  label: string
  available: boolean
}

export const WMS_CONNECTORS: readonly WmsConnectorDef[] = [
  {
    id: 'mintsoft',
    label: 'Mintsoft',
    available: true,
  },
] as const

export function getWmsConnectorDef(id: WmsConnectorId): WmsConnectorDef {
  const connector = WMS_CONNECTORS.find((item) => item.id === id)
  if (!connector) throw new Error(`Unknown WMS connector: ${id}`)
  return connector
}

export function getWmsConnector(id: WmsConnectorId): WmsConnector {
  switch (id) {
    case 'mintsoft':
      return new MintsoftConnector()
    default:
      throw new Error(`Unknown WMS connector: ${id}`)
  }
}
