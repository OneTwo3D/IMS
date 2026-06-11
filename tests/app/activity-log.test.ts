import assert from 'node:assert/strict'
import test from 'node:test'

import {
  invoicePdfTokenSecurityEventWhere,
  summarizeInvoicePdfTokenSecurityEvents,
} from '@/app/actions/activity-log'

test('invoice PDF token security summary groups wrong-session and wrong-IP events by order', () => {
  const rows = summarizeInvoicePdfTokenSecurityEvents([
    {
      id: 'event-old-rejected',
      entityId: 'order-1',
      action: 'invoice_pdf_token_rejected',
      level: 'WARNING',
      description: 'Invoice PDF token rejected: wrong_session',
      metadata: { reason: 'wrong_session', userAgent: 'Browser A' },
      createdAt: new Date('2026-06-01T09:00:00.000Z'),
    },
    {
      id: 'event-new-security',
      entityId: 'order-1',
      action: 'invoice_pdf_token_security_signal',
      level: 'WARNING',
      description: 'Invoice PDF token security signal: wrong_ip',
      metadata: { reason: 'wrong_ip', userAgent: 'Browser B' },
      createdAt: new Date('2026-06-01T10:00:00.000Z'),
    },
    {
      id: 'event-ordinary',
      entityId: 'order-1',
      action: 'invoice_pdf_token_rejected',
      level: 'WARNING',
      description: 'Invoice PDF token rejected: bad_signature',
      metadata: { reason: 'bad_signature', userAgent: 'Browser C' },
      createdAt: new Date('2026-06-01T11:00:00.000Z'),
    },
    {
      id: 'event-order-2',
      entityId: 'order-2',
      action: 'invoice_pdf_token_security_signal',
      level: 'WARNING',
      description: 'Invoice PDF token security signal: wrong_ip',
      metadata: { reason: 'wrong_ip', userAgent: 'Browser D' },
      createdAt: new Date('2026-06-01T08:00:00.000Z'),
    },
  ])

  assert.deepEqual(rows, [
    {
      orderId: 'order-1',
      eventCount: 2,
      wrongSessionCount: 1,
      wrongIpCount: 1,
      userAgents: ['Browser A', 'Browser B'],
      latestAt: '2026-06-01T10:00:00.000Z',
      latestDescription: 'Invoice PDF token security signal: wrong_ip',
      latestEventId: 'event-new-security',
    },
    {
      orderId: 'order-2',
      eventCount: 1,
      wrongSessionCount: 0,
      wrongIpCount: 1,
      userAgents: ['Browser D'],
      latestAt: '2026-06-01T08:00:00.000Z',
      latestDescription: 'Invoice PDF token security signal: wrong_ip',
      latestEventId: 'event-order-2',
    },
  ])
})

test('invoice PDF token security query filters to source reasons the summarizer uses', () => {
  assert.deepEqual(invoicePdfTokenSecurityEventWhere(), {
    tag: 'auth',
    level: 'WARNING',
    action: { in: ['invoice_pdf_token_security_signal', 'invoice_pdf_token_rejected'] },
    OR: [
      { metadata: { path: ['reason'], equals: 'wrong_session' } },
      { metadata: { path: ['reason'], equals: 'wrong_ip' } },
    ],
  })
})
