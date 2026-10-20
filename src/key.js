import { createHash } from 'node:crypto'

/**
 * @typedef {object} SendKeyInput
 * @property {string} channel Where it goes: 'email', 'sms', 'slack', 'webhook'. Case does
 *   not matter.
 * @property {string} to Who it goes to. Trimmed. Email addresses are lower-cased; phone
 *   numbers keep a leading "+" and their digits only, so "+1 (555) 010-0199" and
 *   "+15550100199" are the same recipient. Anything else (a Slack user id, a URL) is kept
 *   as written apart from the trim, because case can matter there.
 * @property {string} intent What the message is for, in your own words and stable across
 *   runs: 'invoice-reminder:inv_1042', 'welcome', 'renewal-notice:2026'. Trimmed, and
 *   case-sensitive. Not the message body: a reworded draft of the same reminder is still
 *   the same intent.
 * @property {string | number} [window] Lets the same intent go out again later. Give a
 *   day ('2026-09-27'), a week, a billing period, anything you can recompute. The same
 *   window means the same key; a new window is a new key. Leave it out for "once, ever".
 */

/**
 * A stable key for one intended send. It names the intent, not the attempt: every
 * retry, every rerun of the job, every process that tries to send the same thing to the
 * same person in the same window gets the same key, which is what lets the ledger say
 * no to all but one of them.
 *
 * The key is the sha256, in hex, of a canonical serialization of the normalised fields,
 * so it is safe to store and log without holding the recipient in clear text (though
 * it is not a secret: anyone with the inputs can recompute it).
 *
 * @param {SendKeyInput} input
 * @returns {string} 64 lower-case hex characters.
 */
export function sendKey(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('sendKey needs { channel, to, intent }.')
  }
  const channel = requiredString(input.channel, 'channel').toLowerCase()
  const to = normaliseRecipient(requiredString(input.to, 'to'))
  const intent = requiredString(input.intent, 'intent')
  /** @type {string | null} */
  let window = null
  if (input.window !== undefined && input.window !== null) {
    if (typeof input.window === 'number' && Number.isFinite(input.window)) {
      window = String(input.window)
    } else {
      window = requiredString(input.window, 'window')
    }
  }
  return sha256(JSON.stringify(['send-once:v1', channel, to, intent, window]))
}

/**
 * Normalises a recipient the way `sendKey` does, so two spellings of the same address
 * cannot slip past the ledger as two different people.
 *
 * @param {string} to
 * @returns {string}
 */
export function normaliseRecipient(to) {
  const trimmed = to.trim()
  if (trimmed.includes('@')) return trimmed.toLowerCase()
  if (/^\+?[\d\s().-]+$/.test(trimmed)) {
    const digits = trimmed.replace(/\D/g, '')
    if (digits.length >= 7) return `${trimmed.startsWith('+') ? '+' : ''}${digits}`
  }
  return trimmed
}

/**
 * JSON with object keys sorted at every level, so two objects with the same content
 * serialize the same way whatever order their keys were written in. Follows JSON rules
 * otherwise: `toJSON` is honoured (Dates become ISO strings), undefined and functions
 * are dropped from objects and become null in arrays.
 *
 * @param {unknown} value
 * @returns {string | undefined} undefined only when the value itself is undefined or a function.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (value !== null && typeof value === 'object' && 'toJSON' in value && typeof value.toJSON === 'function') {
    value = value.toJSON()
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      const sorted = sortKeys(item)
      return sorted === undefined ? null : sorted
    })
  }
  if (value !== null && typeof value === 'object') {
    const source = /** @type {Record<string, unknown>} */ (value)
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const key of Object.keys(source).sort()) {
      const sorted = sortKeys(source[key])
      if (sorted !== undefined) out[key] = sorted
    }
    return out
  }
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  return value
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {string}
 */
function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`sendKey: ${name} must be a non-empty string.`)
  }
  return value.trim()
}
