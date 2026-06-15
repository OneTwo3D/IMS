import { redirect } from 'next/navigation'

// audit-00o7: the standalone Reorder Forecast page was retired. Its still-useful
// pieces — the historical-sales import and the ABC/urgency/search filters — now live
// on the maintained Reorder Planning report. Keep this route as a redirect so old
// bookmarks and deep links (e.g. import-complete notifications) keep working.
export default function ForecastPage() {
  redirect('/analytics/reorder')
}
