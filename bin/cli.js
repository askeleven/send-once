#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { createLedger, fileStore, parseDuration, SendOnceError } from '../src/index.js'
import { parseLedger } from '../src/stores.js'
import { buildAudit, formatAudit } from '../src/report.js'
import { VERSION } from '../src/version.js'

const USAGE = `
send-once audit <ledger.jsonl> [--older-than <duration>]
send-once resolve <ledger.jsonl> <key> sent|failed [--by <name>] [--note <text>]

  audit     Lists sends whose outcome is unknown: claimed, and never confirmed as
            sent or failed. Each one may or may not have reached the provider, and
            send-once will not send it again until someone resolves it.
  resolve   Records what happened to one of them, after checking the provider.
            "failed" lets the next attempt send it; "sent" closes it.

Options
  --older-than <d>      audit: leave out entries claimed more recently than this,
                        which may still be sending. 30s, 10m, 12h, 2d. Default 0.
  --by <name>           resolve: who is resolving it. Default the current user.
  --note <text>         resolve: why, for the next person to read the ledger.
  --json                Machine-readable output.
  --no-colour           Plain text.
  --version, --help

Exit codes
  audit     0 nothing unknown, 1 something unknown, 2 could not run
  resolve   0 resolved, 1 refused (no such key, or already sent), 2 could not run

Examples
  npx @askeleven/send-once audit ./send-once.jsonl --older-than 10m
  npx @askeleven/send-once resolve ./send-once.jsonl 9f86d0...0a08 sent --note "in provider log"
`

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'older-than': { type: 'string' },
        by: { type: 'string' },
        note: { type: 'string' },
        json: { type: 'boolean', default: false },
        // parseArgs has no --no-x negation, so both spellings are declared explicitly.
        'no-colour': { type: 'boolean', default: false },
        'no-color': { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    })
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed

  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const [command, ...rest] = positionals
  if (command === 'audit') return audit(rest, values)
  if (command === 'resolve') return resolve(rest, values)
  process.stderr.write(`${command ? `Unknown command: ${command}\n` : ''}${USAGE}`)
  return 2
}

/**
 * @param {string[]} args
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {Promise<number>}
 */
async function audit(args, values) {
  if (args.length !== 1) {
    process.stderr.write(`audit takes one ledger file.\n${USAGE}`)
    return 2
  }
  const [file] = args
  if (!existsSync(file)) {
    process.stderr.write(`No such ledger: ${file}\n`)
    return 2
  }

  let olderThanMs = 0
  try {
    if (typeof values['older-than'] === 'string') olderThanMs = parseDuration(values['older-than'])
  } catch (error) {
    process.stderr.write(`--older-than: ${/** @type {Error} */ (error).message}\n`)
    return 2
  }

  const text = await readFile(file, 'utf8')
  const { entries, skipped } = parseLedger(text)
  if (entries.size === 0 && skipped > 0) {
    process.stderr.write(`${file} is not a send-once ledger: none of its ${skipped} lines is an entry.\n`)
    return 2
  }

  const now = Date.now()
  const ledger = createLedger(fileStore(file), { now: () => now })
  const unknown = await ledger.pending({ olderThan: olderThanMs })
  const report = buildAudit([...entries.values()], unknown, {
    ledger: file,
    olderThanMs,
    now,
    skippedLines: skipped,
  })

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write(formatAudit(report, { colour: useColour(values) }))
  }
  return report.unknown.length > 0 ? 1 : 0
}

/**
 * @param {string[]} args
 * @param {Record<string, string | boolean | undefined>} values
 * @returns {Promise<number>}
 */
async function resolve(args, values) {
  if (args.length !== 3) {
    process.stderr.write(`resolve takes a ledger file, a key, and sent or failed.\n${USAGE}`)
    return 2
  }
  const [file, key, status] = args
  if (status !== 'sent' && status !== 'failed') {
    process.stderr.write(`The status must be sent or failed, got ${status}.\n`)
    return 2
  }
  if (!existsSync(file)) {
    process.stderr.write(`No such ledger: ${file}\n`)
    return 2
  }

  const ledger = createLedger(fileStore(file))
  const before = await ledger.get(key)
  let entry
  try {
    entry = await ledger.resolve(key, status, {
      by: typeof values.by === 'string' ? values.by : currentUser(),
      note: typeof values.note === 'string' ? values.note : undefined,
    })
  } catch (error) {
    if (error instanceof SendOnceError && (error.code === 'not_found' || error.code === 'already_sent')) {
      process.stderr.write(`${error.message}\n`)
      return 1
    }
    throw error
  }

  if (values.json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`)
  } else if (before?.status !== status) {
    const next =
      status === 'failed'
        ? 'The next attempt for this key will send it.'
        : 'It will not be sent again.'
    process.stdout.write(`Resolved ${key} as ${status}. ${next}\n`)
  } else {
    process.stdout.write(`${key} was already ${status}. Nothing changed.\n`)
  }
  return 0
}

/** @returns {string | undefined} */
function currentUser() {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

/**
 * Honours --no-colour, --no-color, NO_COLOR, and a non-TTY stdout.
 *
 * @param {Record<string, unknown>} values
 * @returns {boolean}
 */
function useColour(values) {
  if (values['no-colour'] || values['no-color']) return false
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY === true
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 2
  },
)
