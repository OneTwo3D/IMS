/**
 * The download link for a report CSV that carries the report's notices after the data rows (`?notices=1`; see
 * `csvResponseWithNotices` in lib/csv.ts). Export links in the app use this so a downloaded file names what the report left out.
 */
export function csvHrefWithNotices(href: string): string {
  const [path, hash] = href.split('#', 2)
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}notices=1${hash === undefined ? '' : `#${hash}`}`
}
