import { formatDuration } from './duration.js'

/**
 * @typedef {import('./ledger.js').Entry} Entry
 *
 * @typedef {object} UnknownSend
 * @property {string} key
 * @property {string} claimedAt
 * @property {number} ageMs
 * @property {number} attempts
 * @property {Record<string, unknown> | null} meta
 * @property {string | null} error
 *
 * What `send-once audit` found.
 * @typedef {object} Audit
 * @property {string} ledger The file audited.
 * @property {string} checkedAt ISO 8601.
 * @property {number} olderThanMs Pending entries younger than this were left out.
 * @property {{ total: number, sent: number, failed: number, pending: number }} counts
 * @property {UnknownSend[]} unknown Pending entries at least olderThanMs old, oldest first.
 * @property {number} inFlight Pending entries younger than olderThanMs.
 * @property {number} skippedLines Lines that were not ledger entries.
 */

const COLOURS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
}

/**
 * @param {boolean} enabled
 * @returns {(code: string, text: string) => string}
 */
function painter(enabled) {
  return (code, text) => (enabled ? `${code}${text}${COLOURS.reset}` : text)
}

/**
 * @param {string} text
 * @param {number} width
 * @param {string} indent
 * @returns {string}
 */
function wrap(text, width, indent) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines.map((l) => indent + l).join('\n')
}

/**
 * @param {Entry[]} entries Every entry in the ledger.
 * @param {Entry[]} unknown The pending entries old enough to report.
 * @param {{ ledger: string, olderThanMs: number, now: number, skippedLines: number }} context
 * @returns {Audit}
 */
export function buildAudit(entries, unknown, context) {
  const counts = { total: entries.length, sent: 0, failed: 0, pending: 0 }
  for (const e of entries) counts[e.status]++
  return {
    ledger: context.ledger,
    checkedAt: new Date(context.now).toISOString(),
    olderThanMs: context.olderThanMs,
    counts,
    unknown: unknown.map((e) => ({
      key: e.key,
      claimedAt: e.claimedAt,
      ageMs: Math.max(0, context.now - Date.parse(e.claimedAt)),
      attempts: e.attempts,
      meta: e.meta ?? null,
      error: e.error ?? null,
    })),
    inFlight: counts.pending - unknown.length,
    skippedLines: context.skippedLines,
  }
}

/**
 * @param {Audit} audit
 * @param {{ colour?: boolean, width?: number }} [options]
 * @returns {string}
 */
export function formatAudit(audit, options = {}) {
  const { colour = true, width = 76 } = options
  const paint = painter(colour)
  const { counts, unknown } = audit
  const lines = ['']

  if (unknown.length === 0) {
    lines.push(`${paint(COLOURS.green, 'OK')}  ${paint(COLOURS.bold, `Nothing unresolved in ${audit.ledger}`)}`)
  } else {
    const n = unknown.length
    lines.push(
      `${paint(COLOURS.red, 'UNKNOWN')}  ` +
        paint(COLOURS.bold, `${n} send${n === 1 ? '' : 's'} may or may not have gone out`),
    )
  }
  lines.push('')
  lines.push(`      ${String(counts.total).padStart(6)} in the ledger`)
  lines.push(`      ${paint(COLOURS.green, String(counts.sent).padStart(6))} sent`)
  lines.push(`      ${paint(COLOURS.yellow, String(counts.failed).padStart(6))} failed, may be retried`)
  lines.push(`      ${paint(COLOURS.red, String(counts.pending).padStart(6))} pending`)

  for (const u of unknown) {
    lines.push('')
    lines.push(`  ${u.key}`)
    lines.push(
      paint(
        COLOURS.dim,
        `      claimed ${u.claimedAt}, ${formatDuration(u.ageMs)} ago, attempt ${u.attempts}`,
      ),
    )
    for (const field of formatMeta(u.meta)) lines.push(wrap(field, width - 6, '      '))
    if (u.error) lines.push(wrap(`last error: ${u.error}`, width - 6, '      '))
  }

  /** @type {string[]} */
  const notes = []
  if (unknown.length > 0) {
    notes.push(
      'Each of these was claimed and never confirmed. The send may have reached the ' +
        'provider or may not. send-once will not send them again on its own. Check each ' +
        'one with the provider, then record what happened:',
    )
  }
  if (audit.inFlight > 0) {
    notes.push(
      `${audit.inFlight} more pending ${audit.inFlight === 1 ? 'entry was' : 'entries were'} ` +
        `claimed less than ${formatDuration(audit.olderThanMs)} ago and may still be sending.`,
    )
  }
  if (audit.skippedLines > 0) {
    notes.push(
      `${audit.skippedLines} line${audit.skippedLines === 1 ? ' was' : 's were'} not a ledger ` +
        'entry and skipped. A torn last line is left by a crash mid-write; it never counted.',
    )
  }
  if (notes.length) lines.push('')
  for (const [i, note] of notes.entries()) {
    if (i > 0) lines.push('')
    lines.push(wrap(note, width - 2, '  '))
    if (i === 0 && unknown.length > 0) {
      lines.push(`    send-once resolve ${audit.ledger} <key> sent`)
      lines.push(`    send-once resolve ${audit.ledger} <key> failed`)
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

/**
 * @param {Record<string, unknown> | null} meta
 * @returns {string[]} One "name: value" per field.
 */
function formatMeta(meta) {
  if (!meta) return []
  return Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
}
