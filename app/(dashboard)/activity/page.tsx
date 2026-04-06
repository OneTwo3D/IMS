import type { Metadata } from 'next'
import { getActivityLogs, getActivityTags } from '@/app/actions/activity-log'
import { ActivityClient } from './activity-client'

export const metadata: Metadata = { title: 'Activity Log' }

export default async function Page() {
  const [{ rows, total }, tags] = await Promise.all([
    getActivityLogs({ page: 1, pageSize: 50 }),
    getActivityTags(),
  ])

  return <ActivityClient initialRows={rows} initialTotal={total} availableTags={tags} />
}
