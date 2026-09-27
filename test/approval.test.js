import test from 'node:test'
import assert from 'node:assert/strict'

import { approve, dispatch, createLedger, memoryStore, sendKey, hashPayload } from '../src/index.js'

const T0 = Date.parse('2026-09-27T09:00:00.000Z')
const HOUR = 3_600_000

const payload = {
  to: 'ana@example.com',
  subject: 'Your invoice',
  body: 'Invoice 1042 is due on Friday.',
}
const key = sendKey({ channel: 'email', to: payload.to, intent: 'invoice-reminder:inv_1042' })

function setup() {
  const ledger = createLedger(memoryStore(), { now: () => T0 })
  /** @type {unknown[]} */
  const sent = []
  /** @param {unknown} p */
  const send = async (p) => {
    sent.push(p)
    return { id: `m${sent.length}` }
  }
  return { ledger, sent, send }
}

test('approve records a hash, a snapshot of the facts, and an expiry', () => {
  const facts = { invoiceStatus: 'unpaid', lastReplyAt: null, due: new Date('2026-10-02T00:00:00Z') }
  const approval = approve({ payload, facts, approvedBy: 'owner@example.com', now: T0 })
  assert.deepEqual(approval, {
    payloadHash: hashPayload(payload),
    facts: { due: '2026-10-02T00:00:00.000Z', invoiceStatus: 'unpaid', lastReplyAt: null },
    approvedAt: '2026-09-27T09:00:00.000Z',
    expiresAt: '2026-09-27T21:00:00.000Z',
    approvedBy: 'owner@example.com',
  })
  facts.invoiceStatus = 'paid'
  assert.equal(approval.facts.invoiceStatus, 'unpaid', 'a snapshot, not a reference')
  assert.deepEqual(JSON.parse(JSON.stringify(approval)), approval, 'plain JSON')

  assert.equal(approve({ payload, ttl: '30m', now: T0 }).expiresAt, '2026-09-27T09:30:00.000Z')
  assert.equal(approve({ payload, now: new Date(T0) }).approvedBy, null)
  assert.throws(() => approve({ payload, ttl: 0, now: T0 }), RangeError)
  assert.throws(() => approve(/** @type {any} */ ({})), TypeError)
  assert.throws(() => approve({ payload, facts: /** @type {any} */ ([1]) }), TypeError)
})

test('dispatch sends while the approval holds, and only once', async () => {
  const { ledger, sent, send } = setup()
  const approval = approve({ payload, facts: { invoiceStatus: 'unpaid' }, approvedBy: 'owner', now: T0 })
  const recheck = async () => ({ invoiceStatus: 'unpaid' })

  const first = await dispatch(approval, { payload, ledger, key, send, recheck, meta: { card: 17 }, now: T0 + HOUR })
  assert.equal(first.outcome, 'sent')
  assert.deepEqual(sent, [payload])
  const entry = await ledger.get(key)
  assert.deepEqual(entry?.meta, { approvedBy: 'owner', approvedAt: '2026-09-27T09:00:00.000Z', card: 17 })

  const second = await dispatch(approval, { payload, ledger, key, send, recheck, now: T0 + 2 * HOUR })
  assert.equal(second.outcome, 'duplicate')
  assert.equal(sent.length, 1)
})

test('dispatch: an expired approval dies instead of firing', async () => {
  const { ledger, sent, send } = setup()
  const approval = approve({ payload, now: T0 })
  let rechecked = false
  const recheck = async () => {
    rechecked = true
    return {}
  }

  const result = await dispatch(approval, { payload, ledger, key, send, recheck, now: T0 + 26 * HOUR })
  assert.deepEqual(result, {
    outcome: 'expired',
    key,
    approvedAt: '2026-09-27T09:00:00.000Z',
    expiresAt: '2026-09-27T21:00:00.000Z',
    ageHours: 26,
  })
  assert.equal(sent.length, 0)
  assert.equal(rechecked, false, 'expiry is checked first')
  assert.equal(await ledger.get(key), null, 'a refusal never touches the ledger')

  const atExpiry = await dispatch(approval, { payload, ledger, key, send, now: T0 + 12 * HOUR })
  assert.equal(atExpiry.outcome, 'sent', 'expiresAt itself is still inside the approval')
})

test('dispatch: a payload that changed after approval is refused', async () => {
  const { ledger, sent, send } = setup()
  const approval = approve({ payload, now: T0 })

  const edited = { ...payload, body: 'Invoice 1042 is overdue.' }
  const result = await dispatch(approval, { payload: edited, ledger, key, send, now: T0 })
  assert.equal(result.outcome, 'payload_changed')
  assert.ok(result.outcome === 'payload_changed' && result.currentHash === hashPayload(edited))
  assert.equal(sent.length, 0)
  assert.equal(await ledger.get(key), null)

  const reordered = { body: payload.body, subject: payload.subject, to: payload.to }
  assert.equal((await dispatch(approval, { payload: reordered, ledger, key, send, now: T0 })).outcome, 'sent')
})

test('dispatch: stale facts are refused, comparing only the facts that were snapshotted', async () => {
  const { ledger, sent, send } = setup()
  const approval = approve({
    payload,
    facts: { invoiceStatus: 'unpaid', lastReplyAt: null, tags: ['a', 'b'] },
    now: T0,
  })

  const result = await dispatch(approval, {
    payload,
    ledger,
    key,
    send,
    now: T0 + HOUR,
    recheck: async () => ({
      invoiceStatus: 'paid',
      tags: ['a', 'b'],
      // Not in the snapshot, so not compared, however much it changed.
      openedEmails: 42,
    }),
  })
  assert.deepEqual(result, {
    outcome: 'stale_facts',
    key,
    changed: [
      { fact: 'invoiceStatus', before: 'unpaid', after: 'paid' },
      { fact: 'lastReplyAt', before: null, after: null },
    ],
  })
  assert.equal(sent.length, 0)
  assert.equal(await ledger.get(key), null)

  const unchanged = await dispatch(approval, {
    payload,
    ledger,
    key,
    send,
    now: T0 + HOUR,
    recheck: () => ({ tags: ['a', 'b'], lastReplyAt: null, invoiceStatus: 'unpaid', openedEmails: 43 }),
  })
  assert.equal(unchanged.outcome, 'sent')
})

test('dispatch: a missing fact counts as changed, even when it was null before', async () => {
  const { ledger, send } = setup()
  const approval = approve({ payload, facts: { lastReplyAt: null }, now: T0 })
  const result = await dispatch(approval, { payload, ledger, key, send, recheck: () => ({}), now: T0 })
  assert.equal(result.outcome, 'stale_facts')
})

test('dispatch rejects things that are not approvals or options', async () => {
  const { ledger, send } = setup()
  const approval = approve({ payload, now: T0 })
  await assert.rejects(dispatch(/** @type {any} */ ({ payloadHash: 'x' }), { payload, ledger, key, send }), TypeError)
  await assert.rejects(dispatch(approval, /** @type {any} */ ({ payload, key, send })), TypeError)
  await assert.rejects(dispatch(approval, { payload, ledger, key: '', send, now: T0 }), TypeError)
  await assert.rejects(
    dispatch(approval, { payload, ledger, key, send, now: T0, recheck: /** @type {any} */ (() => null) }),
    TypeError,
  )
})
