import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { join } from 'pathe'

const CPU_FLOOR_PERCENT = 5
const ALLOCATION_FLOOR_PERCENT = 2
const ALLOCATION_FLOOR_BYTES = 32
const SIZE_FLOOR_BYTES = 16

function formatBytes(bytes) {
  const absolute = Math.abs(bytes)
  if (absolute < 1024)
    return `${Math.round(bytes)} B`
  if (absolute < 1024 * 1024)
    return `${(bytes / 1024).toFixed(2)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function formatValue(bench) {
  if (bench.kind === 'time') {
    if (Math.abs(bench.value) < 0.1)
      return `${(bench.value * 1_000).toFixed(2)} µs`
    return `${bench.value.toFixed(2)} ms`
  }
  return formatBytes(bench.value)
}

function formatPercent(percent) {
  return `${percent > 0 ? '+' : '-'}${Math.abs(percent).toFixed(1)}%`
}

function classify(bench, base) {
  if (!base)
    return { base, bench, deltaPercent: 0, status: 'new' }

  const delta = bench.value - base.value
  const deltaPercent = base.value === 0 ? 0 : delta / Math.abs(base.value) * 100
  let significant = false
  if (bench.kind === 'time') {
    const noiseGate = bench.comparisonRme === undefined
      ? 2 * ((base.rme ?? 0) + (bench.rme ?? 0))
      : 2 * bench.comparisonRme
    significant = Math.abs(deltaPercent) > Math.max(CPU_FLOOR_PERCENT, noiseGate)
  }
  else if (bench.kind === 'alloc') {
    significant = Math.abs(delta) >= ALLOCATION_FLOOR_BYTES
      && (base.value === 0 || Math.abs(deltaPercent) > ALLOCATION_FLOOR_PERCENT)
  }
  else {
    significant = Math.abs(delta) >= SIZE_FLOOR_BYTES
  }

  if (!significant)
    return { base, bench, deltaPercent, status: 'noise' }
  return { base, bench, deltaPercent, status: delta > 0 ? 'regression' : 'improvement' }
}

function deltaCell(row) {
  if (row.status === 'new')
    return '🆕 new'
  if (row.status === 'noise')
    return '~ noise'
  if (row.bench.informational)
    return `ℹ️ ${formatPercent(row.deltaPercent)}`

  const marker = row.status === 'regression' ? '🔴' : '🟢'
  if (row.bench.kind === 'time')
    return `${marker} ${formatPercent(row.deltaPercent)}`
  const delta = row.bench.value - row.base.value
  return `${marker} ${delta > 0 ? '+' : '-'}${formatBytes(Math.abs(delta))} (${formatPercent(row.deltaPercent)})`
}

export function renderPerformanceReport(baseRun, pullRequestRun, baseLabel) {
  const rows = pullRequestRun.benches.map(bench => classify(
    bench,
    baseRun?.benches.find(base => base.id === bench.id),
  ))
  const changed = rows.filter(row => !row.bench.informational
    && (row.status === 'regression' || row.status === 'improvement'))
  const regressions = changed.filter(row => row.status === 'regression')
  const improvements = changed.filter(row => row.status === 'improvement')
  const newMeasurements = rows.filter(row => row.status === 'new')
  const output = ['### ⚡ Wide Event Performance', '']

  if (regressions.length || improvements.length) {
    const verdict = []
    if (regressions.length)
      verdict.push(`${regressions.length} regression${regressions.length === 1 ? '' : 's'}`)
    if (improvements.length)
      verdict.push(`${improvements.length} improvement${improvements.length === 1 ? '' : 's'}`)
    output.push(`${regressions.length ? '🔴' : '🟢'} **${verdict.join(' · ')}**`)
  }
  else if (newMeasurements.length) {
    output.push(`🆕 **${newMeasurements.length} new baseline measurement${newMeasurements.length === 1 ? '' : 's'}**`)
  }
  else {
    output.push('✅ **No significant change** _(within CI noise)_')
  }

  if (changed.length) {
    output.push('', '| Measurement | base → PR | Δ |', '|---|---|---|')
    for (const row of changed)
      output.push(`| **${row.bench.name}** | ${formatValue(row.base)} → ${formatValue(row.bench)} | ${deltaCell(row)} |`)
  }

  output.push(
    '',
    `<details><summary>All measurements (${rows.length})</summary>`,
    '',
    '| Measurement | PR | Δ | RME |',
    '|---|---|---|---|',
  )
  for (const row of rows) {
    const rme = row.bench.comparisonRme === undefined
      ? row.bench.rme === undefined ? '—' : `±${row.bench.rme.toFixed(1)}%`
      : `±${row.bench.comparisonRme.toFixed(1)}% paired`
    output.push(`| ${row.bench.name} | ${formatValue(row.bench)} | ${deltaCell(row)} | ${rme} |`)
  }
  output.push('', '</details>')

  if (baseLabel)
    output.push('', `<sub>Baseline: ${baseLabel} · CPU and allocation changes are noise-gated</sub>`)
  return `${output.join('\n')}\n`
}

async function filesUnder(root) {
  const files = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory())
      files.push(...await filesUnder(path))
    else if (entry.name.endsWith('.mjs'))
      files.push(path)
  }
  return files
}

async function serverSize(root) {
  const files = await filesUnder(root)
  const contents = await Promise.all(files.map(file => readFile(file)))
  const sizes = await Promise.all(files.map(file => stat(file)))
  return {
    gzip: contents.reduce((total, contents) => total + gzipSync(contents).byteLength, 0),
    raw: sizes.reduce((total, entry) => total + entry.size, 0),
  }
}

async function readBundleBenches(runDirectory) {
  if (!runDirectory || !existsSync(join(runDirectory, 'enabled')))
    return []
  const [disabled, enabled, runtime] = await Promise.all([
    serverSize(join(runDirectory, 'disabled')),
    serverSize(join(runDirectory, 'enabled')),
    readFile(join(runDirectory, 'server-runtime.js')),
  ])
  return [
    {
      id: 'nitro-gzip',
      kind: 'size',
      name: 'Nitro production contribution, gzip',
      value: enabled.gzip - disabled.gzip,
    },
    {
      id: 'runtime-gzip',
      kind: 'size',
      name: 'Published server runtime, gzip',
      value: gzipSync(runtime).byteLength,
    },
    {
      id: 'nitro-raw',
      informational: true,
      kind: 'size',
      name: 'Nitro production contribution, raw',
      value: enabled.raw - disabled.raw,
    },
  ]
}

async function readPerformanceComparisons(paths) {
  const base = []
  const pullRequest = []
  if (!paths)
    return { base, pullRequest }
  for (const path of paths.split(',')) {
    if (path && existsSync(path)) {
      const run = JSON.parse(await readFile(path, 'utf8'))
      base.push(...(run.base?.benches ?? []))
      pullRequest.push(...(run.pullRequest?.benches ?? []))
    }
  }
  return { base, pullRequest }
}

async function main() {
  const [baseBundle, pullRequestBundle, performance] = await Promise.all([
    readBundleBenches(process.env.BASE_RUN),
    readBundleBenches(process.env.PR_RUN),
    readPerformanceComparisons(process.env.PERF_COMPARISON),
  ])
  const base = baseBundle.length || performance.base.length
    ? { benches: [...baseBundle, ...performance.base] }
    : null
  const pullRequest = { benches: [...pullRequestBundle, ...performance.pullRequest] }
  if (!pullRequest.benches.length)
    throw new Error('The pull request produced no performance measurements.')
  process.stdout.write(renderPerformanceReport(base, pullRequest, process.env.BASE_LABEL))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}
