import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ensureCurrentReleaseNotificationInStore,
  getReleaseNotificationId,
  CURRENT_RELEASE,
} from '../../lib/releases.ts'

type ReleaseRow = {
  id: string
  userId: string | null
  type: string
  title: string
  message: string
  actionUrl: string | null
}

function createNotificationStore(initial?: ReleaseRow) {
  let row = initial ?? null
  const calls = {
    createMany: 0,
    findUnique: 0,
    update: 0,
  }

  return {
    calls,
    get row() {
      return row
    },
    store: {
      async createMany({ data }: { data: ReleaseRow[]; skipDuplicates: boolean }) {
        calls.createMany += 1
        if (row) return { count: 0 }
        row = data[0] ?? null
        return { count: row ? 1 : 0 }
      },
      async findUnique({ where }: { where: { id: string } }) {
        calls.findUnique += 1
        if (!row || row.id !== where.id) return null
        return {
          userId: row.userId,
          type: row.type,
          title: row.title,
          message: row.message,
          actionUrl: row.actionUrl,
        }
      },
      async update({ where, data }: { where: { id: string }; data: Omit<ReleaseRow, 'id'> }) {
        calls.update += 1
        if (row?.id === where.id) {
          row = { id: row.id, ...data }
        }
        return row
      },
    },
  }
}

function expectedReleaseNotification(): ReleaseRow {
  return {
    id: getReleaseNotificationId(CURRENT_RELEASE.version),
    userId: null,
    type: 'info',
    title: `What's New in ${CURRENT_RELEASE.version}`,
    message: CURRENT_RELEASE.userMessage,
    actionUrl: '/settings/system?tab=releases',
  }
}

test('current release notification creates once and does not rewrite unchanged rows', async () => {
  const fixture = createNotificationStore()

  await ensureCurrentReleaseNotificationInStore(fixture.store)
  assert.deepEqual(fixture.row, expectedReleaseNotification())
  assert.deepEqual(fixture.calls, {
    createMany: 1,
    findUnique: 0,
    update: 0,
  })

  await ensureCurrentReleaseNotificationInStore(fixture.store)
  assert.deepEqual(fixture.row, expectedReleaseNotification())
  assert.deepEqual(fixture.calls, {
    createMany: 2,
    findUnique: 1,
    update: 0,
  })
})

test('current release notification updates existing drifted rows only', async () => {
  const expected = expectedReleaseNotification()
  const fixture = createNotificationStore({
    ...expected,
    title: 'Old release title',
    message: 'Old release message',
  })

  await ensureCurrentReleaseNotificationInStore(fixture.store)

  assert.deepEqual(fixture.row, expected)
  assert.deepEqual(fixture.calls, {
    createMany: 1,
    findUnique: 1,
    update: 1,
  })
})
