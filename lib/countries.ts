/** ISO 3166-1 alpha-2 country codes → English names (common trading countries first). */
const COUNTRIES: Record<string, string> = {
  GB: 'United Kingdom', US: 'United States', CN: 'China', DE: 'Germany', FR: 'France',
  IT: 'Italy', ES: 'Spain', NL: 'Netherlands', BE: 'Belgium', IE: 'Ireland',
  PL: 'Poland', CZ: 'Czech Republic', AT: 'Austria', SE: 'Sweden', DK: 'Denmark',
  NO: 'Norway', FI: 'Finland', PT: 'Portugal', CH: 'Switzerland', JP: 'Japan',
  KR: 'South Korea', TW: 'Taiwan', IN: 'India', VN: 'Vietnam', TH: 'Thailand',
  MY: 'Malaysia', ID: 'Indonesia', PH: 'Philippines', BD: 'Bangladesh', PK: 'Pakistan',
  TR: 'Turkey', MX: 'Mexico', BR: 'Brazil', CA: 'Canada', AU: 'Australia',
  NZ: 'New Zealand', ZA: 'South Africa', AE: 'United Arab Emirates', SA: 'Saudi Arabia',
  IL: 'Israel', EG: 'Egypt', RO: 'Romania', HU: 'Hungary', SK: 'Slovakia',
  BG: 'Bulgaria', HR: 'Croatia', SI: 'Slovenia', LT: 'Lithuania', LV: 'Latvia',
  EE: 'Estonia', GR: 'Greece', CY: 'Cyprus', MT: 'Malta', LU: 'Luxembourg',
  IS: 'Iceland', LI: 'Liechtenstein', HK: 'Hong Kong', SG: 'Singapore',
  RU: 'Russia', UA: 'Ukraine', RS: 'Serbia', BA: 'Bosnia and Herzegovina',
  MK: 'North Macedonia', AL: 'Albania', ME: 'Montenegro', XK: 'Kosovo',
  AR: 'Argentina', CL: 'Chile', CO: 'Colombia', PE: 'Peru', EC: 'Ecuador',
  UY: 'Uruguay', PY: 'Paraguay', BO: 'Bolivia', VE: 'Venezuela', CR: 'Costa Rica',
  PA: 'Panama', DO: 'Dominican Republic', GT: 'Guatemala', CU: 'Cuba', JM: 'Jamaica',
  NG: 'Nigeria', KE: 'Kenya', GH: 'Ghana', TZ: 'Tanzania', ET: 'Ethiopia',
  MA: 'Morocco', TN: 'Tunisia', DZ: 'Algeria', LY: 'Libya', CM: 'Cameroon',
  CI: "Côte d'Ivoire", SN: 'Senegal', UG: 'Uganda', MZ: 'Mozambique',
  QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', JO: 'Jordan', LB: 'Lebanon',
  IQ: 'Iraq', IR: 'Iran', AF: 'Afghanistan', MM: 'Myanmar', KH: 'Cambodia',
  LA: 'Laos', NP: 'Nepal', LK: 'Sri Lanka', MN: 'Mongolia', KZ: 'Kazakhstan',
  UZ: 'Uzbekistan', GE: 'Georgia', AM: 'Armenia', AZ: 'Azerbaijan',
}

/** All country entries sorted alphabetically by name. */
export const COUNTRY_LIST: { code: string; name: string }[] = Object.entries(COUNTRIES)
  .map(([code, name]) => ({ code, name }))
  .sort((a, b) => a.name.localeCompare(b.name))

/** Get country name from ISO code, or return the code itself if not found. */
export function countryName(code: string | null | undefined): string {
  if (!code) return ''
  return COUNTRIES[code.toUpperCase()] ?? code
}
