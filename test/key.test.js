import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { sendKey, normaliseRecipient, parseDuration, hashPayload } from '../src/index.js'
import { canonicalJson } from '../src/key.js'
import { formatDuration } from '../src/duration.js'

const base = { channel: 'email', to: 'ana@example.com', intent: 'invoice-reminder:inv_1042', window: '2026-09-27' }

test('sendKey is a stable sha256 of the canonical fields', () => {
  const key = sendKey(base)
  assert.match(key, /^[0-9a-f]{64}$/)
  // Pinned: changing this breaks every ledger already written, so it must never move.
  assert.equal(key, '2ece9e5451aafb30191cdc83a901433506912fbeb772035ccaa91d7802a65a64')
  const expected = createHash('sha256')
    .update(JSON.stringify(['send-once:v1', 'email', 'ana@example.com', 'invoice-reminder:inv_1042', '2026-09-27']))
    .digest('hex')
  assert.equal(key, expected)
})

test('sendKey normalises the recipient and channel, not the intent', () => {
  const key = sendKey(base)
  assert.equal(sendKey({ ...base, to: '  Ana@Example.COM ' }), key)
  assert.equal(sendKey({ ...base, channel: ' EMAIL' }), key)
  assert.equal(sendKey({ ...base, intent: ' invoice-reminder:inv_1042 ' }), key)
  assert.notEqual(sendKey({ ...base, intent: 'Invoice-reminder:inv_1042' }), key)
})

test('sendKey: a different channel, intent or window is a different key', () => {
  const key = sendKey(base)
  assert.notEqual(sendKey({ ...base, channel: 'sms' }), key)
  assert.notEqual(sendKey({ ...base, intent: 'invoice-reminder:inv_1043' }), key)
  assert.notEqual(sendKey({ ...base, window: '2026-09-28' }), key)
  const { window, ...once } = base
  assert.notEqual(sendKey(once), key, 'no window is its own key')
  assert.equal(sendKey({ ...once, window: undefined }), sendKey(once))
  assert.equal(sendKey({ ...base, window: 7 }), sendKey({ ...base, window: '7' }))
})

test('sendKey refuses missing or empty fields', () => {
  assert.throws(() => sendKey(/** @type {any} */ ({ channel: 'email', to: 'a@b.co' })), TypeError)
  assert.throws(() => sendKey({ channel: 'email', to: '  ', intent: 'x' }), TypeError)
  assert.throws(() => sendKey({ ...base, window: '' }), TypeError)
  assert.throws(() => sendKey(/** @type {any} */ (null)), TypeError)
})

test('normaliseRecipient: emails lower-cased, phones to digits, other ids kept', () => {
  assert.equal(normaliseRecipient(' Bob@Acme.io '), 'bob@acme.io')
  assert.equal(normaliseRecipient('+1 (555) 010-0199'), '+15550100199')
  assert.equal(normaliseRecipient('+1.555.010.0199'), '+15550100199')
  assert.equal(normaliseRecipient('555 010 0199'), '5550100199')
  assert.equal(normaliseRecipient('U024BE7LH'), 'U024BE7LH', 'case can matter in platform ids')
  assert.equal(normaliseRecipient('12-34'), '12-34', 'too short to be a phone number')
})

test('canonicalJson sorts keys at every level and follows JSON rules', () => {
  const a = canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } })
  const b = canonicalJson({ a: { d: [1, { y: 2, z: 1 }] }, b: 1 })
  assert.equal(a, b)
  assert.equal(a, '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}')
  assert.equal(canonicalJson([undefined, () => 1]), '[null,null]')
  assert.equal(canonicalJson(new Date('2026-09-27T00:00:00Z')), '"2026-09-27T00:00:00.000Z"')
  assert.equal(hashPayload({ x: 1, y: 2 }), hashPayload({ y: 2, x: 1 }))
})

test('parseDuration reads units and milliseconds', () => {
  assert.equal(parseDuration('30s'), 30_000)
  assert.equal(parseDuration('15m'), 900_000)
  assert.equal(parseDuration('12h'), 43_200_000)
  assert.equal(parseDuration('2d'), 172_800_000)
  assert.equal(parseDuration('500ms'), 500)
  assert.equal(parseDuration('1.5h'), 5_400_000)
  assert.equal(parseDuration(' 10m '), 600_000)
  assert.equal(parseDuration(1234), 1234)
  assert.equal(parseDuration(0), 0)
})

test('parseDuration refuses what it would have to guess at', () => {
  assert.throws(() => parseDuration('600'), TypeError, 'a unit is required')
  assert.throws(() => parseDuration('10M'), TypeError, 'units are lower case')
  assert.throws(() => parseDuration('1h30m'), TypeError)
  assert.throws(() => parseDuration('soon'), TypeError)
  assert.throws(() => parseDuration(-1), RangeError)
  assert.throws(() => parseDuration(Number.NaN), RangeError)
  assert.throws(() => parseDuration(/** @type {any} */ (null)), TypeError)
})

test('formatDuration shows two units at most', () => {
  assert.equal(formatDuration(35_000), '35s')
  assert.equal(formatDuration(15 * 60_000), '15m')
  assert.equal(formatDuration(4 * 3_600_000 + 12 * 60_000 + 5_000), '4h 12m')
  assert.equal(formatDuration(2 * 86_400_000 + 3 * 3_600_000), '2d 3h')
  assert.equal(formatDuration(-5), '0s')
})
