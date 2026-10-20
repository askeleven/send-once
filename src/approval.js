import { canonicalJson, sha256 } from './key.js'
import { parseDuration, toMillis } from './duration.js'

/**
 * @typedef {import('./duration.js').Duration} Duration
 * @typedef {import('./duration.js').Moment} Moment
 * @typedef {import('./ledger.js').Ledger} Ledger
 * @typedef {import('./ledger.js').OnceResult} OnceResult
 * @typedef {import('./ledger.js').SendContext} SendContext
 *
 * A person's yes to one exact payload, under the facts they could see, for a limited
 * time. Plain JSON: store it with the approval card, pass it back to `dispatch()`.
 * @typedef {object} Approval
 * @property {string} payloadHash sha256 of the payload's canonical JSON.
 * @property {Record<string, unknown>} facts What was true when the person said yes, as
 *   JSON. Only these names are compared at dispatch.
 * @property {string} approvedAt ISO 8601.
 * @property {string} expiresAt ISO 8601. After this the approval dies rather than fires.
 * @property {string | null} approvedBy
 *
 * @typedef {object} ApproveOptions
 * @property {unknown} payload Exactly what will be sent: recipient, subject, body,
 *   attachments. Anything that, if changed, the person should see again.
 * @property {Record<string, unknown>} [facts] What the decision depends on that could
 *   change before the send: `{ invoiceStatus: 'unpaid', lastReplyAt: null }`.
 * @property {Duration} [ttl] How long the approval holds. Default '12h'.
 * @property {string} [approvedBy]
 * @property {Moment} [now]
 *
 * @typedef {object} FactChange
 * @property {string} fact
 * @property {unknown} before As snapshotted at approval.
 * @property {unknown} after As `recheck()` reported it; null when it was missing.
 *
 * @typedef {{ outcome: 'expired', key: string, approvedAt: string, expiresAt: string, ageHours: number }} ExpiredRefusal
 *   The approval is older than its ttl. Ask again.
 * @typedef {{ outcome: 'payload_changed', key: string, approvedHash: string, currentHash: string }} PayloadChangedRefusal
 *   What would be sent is not what was approved. Ask again.
 * @typedef {{ outcome: 'stale_facts', key: string, changed: FactChange[] }} StaleFactsRefusal
 *   Something the approval depended on is no longer true. Ask again, or drop it.
 * @typedef {ExpiredRefusal | PayloadChangedRefusal | StaleFactsRefusal} Refusal
 *
 * @typedef {OnceResult | Refusal} DispatchResult
 */

/**
 * @template P
 * @typedef {object} DispatchOptions
 * @property {P} payload What is about to be sent. Hashed and compared to the approval.
 * @property {Ledger} ledger
 * @property {string} key From `sendKey()`.
 * @property {(payload: P, context: SendContext) => Promise<unknown> | unknown} send
 * @property {() => Promise<Record<string, unknown>> | Record<string, unknown>} [recheck]
 *   Looks the facts up again, now. Without it the snapshot is kept for the record but
 *   not compared.
 * @property {Record<string, unknown>} [meta] Stored in the ledger entry, alongside who
 *   approved it and when.
 * @property {Moment} [now]
 */

/**
 * Records an approval. Call it when the person says yes, and keep the result with the
 * thing they approved.
 *
 * @param {ApproveOptions} options
 * @returns {Approval}
 */
export function approve(options) {
  if (!options || typeof options !== 'object' || !('payload' in options) || options.payload === undefined) {
    throw new TypeError('approve needs { payload }.')
  }
  const { payload, facts = {}, ttl = '12h', approvedBy, now = Date.now() } = options
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new TypeError('approve: facts must be an object of named values.')
  }
  const ttlMs = parseDuration(ttl)
  if (ttlMs <= 0) throw new RangeError('approve: ttl must be longer than zero.')
  const approvedAt = toMillis(now)

  return {
    payloadHash: hashPayload(payload),
    facts: /** @type {Record<string, unknown>} */ (JSON.parse(canonicalJson(facts) ?? '{}')),
    approvedAt: new Date(approvedAt).toISOString(),
    expiresAt: new Date(approvedAt + ttlMs).toISOString(),
    approvedBy: approvedBy ?? null,
  }
}

/**
 * Sends an approved payload, if the approval still holds. Checked in this order:
 *
 * 1. expired: now is past `expiresAt`.
 * 2. payload_changed: the payload does not hash to what was approved.
 * 3. stale_facts: `recheck()` (when given) reports a different value for any fact in
 *    the snapshot. Facts it returns that were not in the snapshot are ignored.
 *
 * A refusal never calls `send` and never touches the ledger, so the same key can go out
 * later under a fresh approval. When nothing refuses, it is `ledger.once(key, ...)`, and
 * the result is the ledger's.
 *
 * @template P
 * @param {Approval} approval
 * @param {DispatchOptions<P>} options
 * @returns {Promise<DispatchResult>}
 */
export async function dispatch(approval, options) {
  assertApproval(approval)
  const { payload, ledger, key, send, recheck, meta, now = Date.now() } = options
  if (!ledger || typeof ledger.once !== 'function') throw new TypeError('dispatch needs a ledger.')
  if (typeof key !== 'string' || key === '') throw new TypeError('dispatch needs a key.')
  if (typeof send !== 'function') throw new TypeError('dispatch needs a send function.')

  const at = toMillis(now)
  const approvedAt = Date.parse(approval.approvedAt)
  const expiresAt = Date.parse(approval.expiresAt)
  if (at > expiresAt) {
    return {
      outcome: 'expired',
      key,
      approvedAt: approval.approvedAt,
      expiresAt: approval.expiresAt,
      ageHours: Math.round((at - approvedAt) / 360_000) / 10,
    }
  }

  const currentHash = hashPayload(payload)
  if (currentHash !== approval.payloadHash) {
    return { outcome: 'payload_changed', key, approvedHash: approval.payloadHash, currentHash }
  }

  if (recheck) {
    const current = await recheck()
    if (!current || typeof current !== 'object') {
      throw new TypeError('dispatch: recheck() must return an object of named facts.')
    }
    /** @type {FactChange[]} */
    const changed = []
    for (const fact of Object.keys(approval.facts)) {
      const before = approval.facts[fact]
      const after = current[fact]
      if (canonicalJson(before) !== canonicalJson(after)) {
        changed.push({
          fact,
          before,
          after: after === undefined ? null : JSON.parse(canonicalJson(after) ?? 'null'),
        })
      }
    }
    if (changed.length) return { outcome: 'stale_facts', key, changed }
  }

  return ledger.once(key, (context) => send(payload, context), {
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    ...meta,
  })
}

/**
 * sha256 of a payload's canonical JSON (keys sorted at every level). The same content
 * hashes the same whatever order its keys were built in.
 *
 * @param {unknown} payload
 * @returns {string}
 */
export function hashPayload(payload) {
  const json = canonicalJson(payload)
  if (json === undefined) throw new TypeError('A payload must be JSON-serializable.')
  return sha256(json)
}

/**
 * @param {unknown} approval
 * @returns {asserts approval is Approval}
 */
function assertApproval(approval) {
  const a = /** @type {Partial<Approval> | null} */ (approval)
  if (
    !a || typeof a !== 'object' || typeof a.payloadHash !== 'string' ||
    typeof a.approvedAt !== 'string' || typeof a.expiresAt !== 'string' ||
    Number.isNaN(Date.parse(a.approvedAt)) || Number.isNaN(Date.parse(a.expiresAt)) ||
    !a.facts || typeof a.facts !== 'object'
  ) {
    throw new TypeError('dispatch: not an approval record. Create one with approve().')
  }
}
