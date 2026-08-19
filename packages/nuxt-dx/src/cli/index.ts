#!/usr/bin/env node
/**
 * `nuxt-dx` reads the size budget reports two builds wrote and says what moved.
 * Absolute budgets catch a bundle that is already too big; this catches the pull
 * request that quietly added 40 kB to one that was fine.
 */
import type { CommandDef } from 'citty'
import type { SizeBudgetSnapshot } from '../size-budget/snapshot'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineCommand, runMain } from 'citty'
import { colors } from 'consola/utils'
import { diffSnapshots } from '../size-budget/diff'
import { formatDiffMarkdown, formatDiffVerdict, formatMissingBaselineMarkdown } from '../size-budget/diff-report'
import { kilobytesToBytes } from '../size-budget/size'
import { parseSnapshot } from '../size-budget/snapshot'

/** A target growing by more than this fails the comparison. */
const DEFAULT_THRESHOLD_KB = 10

/** Undefined only when the file is absent, which the baseline is allowed to be. */
async function readSource(path: string): Promise<string | undefined> {
  return await readFile(path, 'utf-8').catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT')
      return undefined
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function readSnapshot(path: string): Promise<SizeBudgetSnapshot> {
  const source = await readSource(path)
  if (source === undefined)
    throw new Error(`No report at ${path}. Build the app with \`nuxtDx.report\` enabled first.`)
  return parseSnapshot(source, path)
}

/**
 * A baseline is usable, absent, or unreadable, and the last two are the same answer to the
 * only question the caller asks: is there anything to compare against. Kept apart so the
 * summary can say which one happened.
 */
type Baseline
  = | { _tag: 'usable', snapshot: SizeBudgetSnapshot }
    | { _tag: 'absent' }
    | { _tag: 'unusable', reason: string }

/**
 * An unreadable baseline is a fact about the baseline, not about the build being checked.
 * Truncated artifacts and reports written in an older format both land here, and a run that
 * fails on either can never replace the baseline that broke it, so the branch stays stuck.
 */
async function readBaseline(path: string): Promise<Baseline> {
  const source = await readSource(path)
  if (source === undefined)
    return { _tag: 'absent' }
  try {
    return { _tag: 'usable', snapshot: parseSnapshot(source, path) }
  }
  catch (error) {
    return { _tag: 'unusable', reason: error instanceof Error ? error.message : String(error) }
  }
}

function thresholdBytes(raw: string): number {
  const kilobytes = Number(raw)
  if (!Number.isFinite(kilobytes) || kilobytes < 0)
    throw new Error(`--threshold-kb expects a non-negative number of kilobytes, received "${raw}".`)
  return kilobytesToBytes(kilobytes)
}

const compare = defineCommand({
  meta: {
    name: 'compare',
    description: 'Diff two size budget reports, failing when a runtime entry grows past the threshold',
  },
  args: {
    'base': { type: 'positional', description: 'Report from the build you are comparing against', required: true },
    'head': { type: 'positional', description: 'Report from the build you are checking', required: true },
    'threshold-kb': { type: 'string', description: 'Growth allowed for a single target, never cumulative, before this fails', default: String(DEFAULT_THRESHOLD_KB) },
    'allow-missing-base': { type: 'boolean', description: 'Report that there is no baseline to compare against and pass, instead of failing. Covers a baseline that is absent, truncated, or written in a format this CLI cannot read', default: false },
  },
  async run({ args }) {
    try {
      const threshold = thresholdBytes(args['threshold-kb'])
      const baseline = await readBaseline(args.base)
      if (baseline._tag !== 'usable') {
        const reason = baseline._tag === 'unusable' ? baseline.reason : undefined
        if (!args['allow-missing-base']) {
          throw new Error(`${reason ?? `No report at ${args.base}.`} Pass --allow-missing-base to treat a baseline you cannot compare against as a pass.`)
        }
        process.stdout.write(`${formatMissingBaselineMarkdown(args.base, reason)}\n`)
        process.stderr.write(`${colors.yellow(`… ${reason ?? `no baseline report at ${args.base}`}, nothing compared`)}\n`)
        return
      }
      const diff = diffSnapshots(baseline.snapshot, await readSnapshot(args.head), threshold)
      // Markdown on stdout so it can be redirected straight into a step summary,
      // the verdict on stderr so a local run still reads as a pass or a fail.
      process.stdout.write(`${formatDiffMarkdown(diff)}\n`)
      process.stderr.write(`${formatDiffVerdict(diff)}\n`)
      if (diff.breaches.length)
        process.exitCode = 1
    }
    catch (error) {
      process.stderr.write(`${colors.red('✖')} ${error instanceof Error ? error.message : String(error)}\n`)
      // Distinct from a breach: nothing was compared, so nothing was proven.
      process.exitCode = 2
    }
  },
})

const main: CommandDef = defineCommand({
  meta: {
    name: 'nuxt-dx',
    description: 'JavaScript size budgets for Nuxt and Nitro runtime entries',
  },
  subCommands: { compare },
})

export { main }

/** True only when this file is the process entry (the `nuxt-dx` bin), not when imported. */
function isCliEntry(): boolean {
  const invoked = process.argv[1]
  if (!invoked)
    return false
  try {
    // realpath both sides so the package manager's `.bin/nuxt-dx` symlink resolves to the dist file.
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  }
  catch {
    return false
  }
}

if (isCliEntry())
  await runMain(main)
