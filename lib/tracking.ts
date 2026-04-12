// ---------------------------------------------------------------------------
// Shared carrier & tracking utilities
// Used by both Sales Order and Purchase Order detail pages.
// ---------------------------------------------------------------------------

export const DEFAULT_CARRIERS = [
  'Royal Mail',
  'DPD',
  'DHL',
  'DHL Express',
  'FedEx',
  'UPS',
  'Hermes / Evri',
  'Yodel',
  'Amazon Logistics',
  'ParcelForce',
  'TNT',
  'GLS',
  'Collect+',
]

export const CARRIER_TRACKING_URLS: Record<string, string> = {
  'Royal Mail': 'https://www.royalmail.com/track-your-item#/tracking-results/',
  'DPD': 'https://track.dpd.co.uk/parcels/',
  'DHL': 'https://www.dhl.com/gb-en/home/tracking/tracking-parcel.html?submit=1&tracking-id=',
  'DHL Express': 'https://www.dhl.com/gb-en/home/tracking/tracking-express.html?submit=1&tracking-id=',
  'FedEx': 'https://www.fedex.com/fedextrack/?trknbr=',
  'UPS': 'https://www.ups.com/track?tracknum=',
  'Hermes / Evri': 'https://www.evri.com/track/parcel/',
  'Yodel': 'https://www.yodel.co.uk/tracking/',
  'Amazon Logistics': 'https://track.amazon.co.uk/tracking/',
  'ParcelForce': 'https://www.parcelforce.com/track-trace?trackNumber=',
  'TNT': 'https://www.tnt.com/express/en_gb/site/tracking.html?searchType=con&cons=',
  'GLS': 'https://gls-group.com/GB/en/parcel-tracking?match=',
  'Collect+': 'https://www.collectplus.co.uk/track/',
}

export function getTrackingUrl(carrier: string | null, trackingNumber: string): string | null {
  if (!carrier || !trackingNumber) return null
  const baseUrl = CARRIER_TRACKING_URLS[carrier]
  if (baseUrl) return baseUrl + encodeURIComponent(trackingNumber)
  // Fallback: try 17track universal tracker
  return `https://t.17track.net/en#nums=${encodeURIComponent(trackingNumber)}`
}
