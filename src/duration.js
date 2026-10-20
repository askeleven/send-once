/**
 * A length of time: milliseconds as a number, or a string with a unit such as '30s',
 * '15m', '12h', '2d' or '500ms'.
 *
 * @typedef {number | string} Duration
 *
 * A moment: a Date, or milliseconds since the epoch.
 * @typedef {Date | number} Moment
 *
 * A clock, for tests and for anyone who needs time to come from somewhere other than
 * the system. Returns a Date or milliseconds since the epoch.
 * @typedef {() => Moment} Clock
 */

const UNITS = /** @type {const} */ ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 })

/**
 * Parses a duration to milliseconds. Strings need a unit, so "600" is refused rather
 * than guessed at. Units are lower case only, so "M" can never be read as minutes when
 * someone meant months.
 *
 * @param {Duration} value
 * @returns {number} Milliseconds, zero or more.
 */
export function parseDuration(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`A duration must be zero or more milliseconds, got ${value}.`)
    }
    return value
  }
  if (typeof value !== 'string') {
    throw new TypeError(`A duration must be a number of milliseconds or a string like "12h".`)
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\s*$/.exec(value)
  if (!match) {
    throw new TypeError(
      `Not a duration: "${value}". Use a number and a unit: 500ms, 30s, 15m, 12h, 2d.`,
    )
  }
  return Number(match[1]) * UNITS[/** @type {keyof typeof UNITS} */ (match[2])]
}

/**
 * @param {Moment} moment
 * @returns {number}
 */
export function toMillis(moment) {
  const ms = moment instanceof Date ? moment.getTime() : moment
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError('A time must be a valid Date or a number of milliseconds.')
  }
  return ms
}

/**
 * @param {Clock | undefined} now
 * @returns {() => number}
 */
export function clockFrom(now) {
  if (now === undefined) return () => Date.now()
  if (typeof now !== 'function') throw new TypeError('now must be a function returning a Date or milliseconds.')
  return () => toMillis(now())
}

/**
 * "4h 12m", "35s", "2d 3h". Two units at most; enough to judge how old something is.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3_600)
  const m = Math.floor((s % 3_600) / 60)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  if (m > 0) return `${m}m`
  return `${s}s`
}
