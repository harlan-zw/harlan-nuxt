import { spawn } from 'node:child_process'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '../..')
const durationSeconds = Number(process.env.BENCH_DURATION ?? 20)
const repetitions = Number(process.env.BENCH_REPETITIONS ?? 3)
const reportConcurrencies = [1, 32, 128]
const concurrencies = process.env.BENCH_CONCURRENCIES
  ? process.env.BENCH_CONCURRENCIES.split(',').map(Number)
  : reportConcurrencies
const targets = {
  disabled: { fixture: join(here, 'disabled'), port: 43101 },
  enabled: { fixture: join(here, 'enabled'), port: 43102 },
  evlog: { fixture: join(here, 'evlog'), port: 43103 },
}

function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: packageRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => stdout += chunk)
    child.stderr?.on('data', chunk => stderr += chunk)
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0)
        resolve({ stdout, stderr })
      else
        reject(new Error(`${program} exited with ${code}.\n${stderr || stdout}`))
    })
  })
}

async function build(target) {
  await command('pnpm', ['exec', 'nuxi', 'build', target.fixture, '--logLevel', 'silent'], {
    env: { ...process.env, NUXT_TELEMETRY_DISABLED: '1' },
  })
}

function start(target) {
  return spawn(process.execPath, [join(target.fixture, '.output/server/index.mjs')], {
    cwd: target.fixture,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: String(target.port),
      PORT: String(target.port),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

async function waitForServer(target) {
  const url = `http://127.0.0.1:${target.port}/api/health`
  for (let attempt = 0; attempt < 100; attempt++) {
    const ready = await fetch(url)
      .then(response => response.ok)
      .catch(() => false)
    if (ready)
      return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Server did not start at ${url}.`)
}

async function runLoad(target, connections, seconds, json) {
  const url = `http://127.0.0.1:${target.port}/api/health`
  const args = [
    '-y',
    'autocannon@8.0.0',
    '--connections',
    String(connections),
    '--duration',
    String(seconds),
    '--pipelining',
    '1',
  ]
  if (json)
    args.push('--json')
  args.push(url)
  const result = await command('npx', args)
  return json ? JSON.parse(result.stdout) : undefined
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

function fixed(value, digits = 1) {
  return Number(value).toFixed(digits)
}

function percentDelta(current, baseline) {
  if (baseline === 0)
    return current === 0 ? '0.0%' : 'unbounded'
  return `${fixed((current / baseline - 1) * 100)}%`
}

async function serverBundleSize(target) {
  const root = join(target.fixture, '.output/server')
  const files = []

  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory())
        await visit(path)
      else if (entry.name.endsWith('.mjs'))
        files.push(path)
    }
  }

  await visit(root)
  const contents = await Promise.all(files.map(file => readFile(file)))
  return {
    files: files.length,
    gzipBytes: contents.reduce((total, content) => total + gzipSync(content).byteLength, 0),
    rawBytes: (await Promise.all(files.map(file => stat(file))))
      .reduce((total, file) => total + file.size, 0),
  }
}

function report(results) {
  const lines = [
    '# Nitro HTTP benchmark results',
    '',
    `Generated: ${results.generatedAt}`,
    '',
    `Runtime: Node ${results.system.node}, ${results.system.cpu}`,
    '',
    `Method: ${results.autocannonVersion}, ${durationSeconds}s, ${repetitions} repetitions, pipelining 1.`,
    '',
    '| Concurrency | Module | Requests/s | p50 | p99 | Throughput delta | p99 delta |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ]

  for (const connections of reportConcurrencies) {
    const disabled = results.summary.disabled[String(connections)]
    lines.push(`| ${connections} | disabled | ${fixed(disabled.requestsPerSecond, 0)} | ${fixed(disabled.p50)} ms | ${fixed(disabled.p99)} ms | baseline | baseline |`)
    for (const mode of ['enabled', 'evlog']) {
      const measured = results.summary[mode][String(connections)]
      lines.push(`| ${connections} | ${mode} | ${fixed(measured.requestsPerSecond, 0)} | ${fixed(measured.p50)} ms | ${fixed(measured.p99)} ms | ${percentDelta(measured.requestsPerSecond, disabled.requestsPerSecond)} | ${percentDelta(measured.p99, disabled.p99)} |`)
    }
  }

  lines.push(
    '',
    'Each cell is the median of all repetitions. See `results.json` for raw autocannon output.',
    '',
    '## Built server JavaScript',
    '',
    '| Module | Raw | Gzip | Incremental raw | Incremental gzip |',
    '| --- | ---: | ---: | ---: | ---: |',
  )
  const baseline = results.bundleSizes.disabled
  for (const mode of Object.keys(targets)) {
    const size = results.bundleSizes[mode]
    lines.push(`| ${mode} | ${size.rawBytes} B | ${size.gzipBytes} B | ${size.rawBytes - baseline.rawBytes} B | ${size.gzipBytes - baseline.gzipBytes} B |`)
  }
  lines.push('', 'Size sums every `.mjs` file in the built Nitro server. Gzip compresses each file separately.', '')
  return `${lines.join('\n')}\n`
}

async function main() {
  const servers = []

  try {
    await command('npx', ['-y', 'autocannon@8.0.0', '--version'])
    for (const target of Object.values(targets))
      await build(target)

    for (const target of Object.values(targets)) {
      const server = start(target)
      servers.push(server)
      await waitForServer(target)
    }

    const previous = process.env.BENCH_CONCURRENCIES
      ? await readFile(join(here, 'results.json'), 'utf8')
          .then(input => JSON.parse(input))
          .catch(() => ({ samples: [] }))
      : { samples: [] }
    const samples = previous.samples.filter(sample => !concurrencies.includes(sample.connections))
    for (const connections of concurrencies) {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const modes = Object.keys(targets)
        const offset = repetition % modes.length
        const order = [...modes.slice(offset), ...modes.slice(0, offset)]
        for (const mode of order) {
          const target = targets[mode]
          await runLoad(target, connections, 3, false)
          const result = await runLoad(target, connections, durationSeconds, true)
          samples.push({ mode, connections, repetition, result })
          process.stdout.write(`${mode} c=${connections} run=${repetition + 1}: ${fixed(result.requests.average, 0)} requests/s\n`)
        }
      }
    }

    const summary = Object.fromEntries(Object.keys(targets).map(mode => [mode, {}]))
    for (const mode of Object.keys(targets)) {
      for (const connections of reportConcurrencies) {
        const matching = samples.filter(sample => sample.mode === mode && sample.connections === connections)
        summary[mode][String(connections)] = {
          requestsPerSecond: median(matching.map(sample => sample.result.requests.average)),
          p50: median(matching.map(sample => sample.result.latency.p50)),
          p99: median(matching.map(sample => sample.result.latency.p99)),
        }
      }
    }

    const [{ stdout: commit }, { stdout: autocannonVersion }] = await Promise.all([
      command('git', ['rev-parse', 'HEAD'], { cwd: packageRoot }),
      command('npx', ['-y', 'autocannon@8.0.0', '--version']),
    ])
    const bundleSizes = Object.fromEntries(await Promise.all(
      Object.entries(targets).map(async ([mode, target]) => [mode, await serverBundleSize(target)]),
    ))
    const results = {
      generatedAt: new Date().toISOString(),
      commit: commit.trim(),
      dirty: true,
      autocannonVersion: autocannonVersion.trim().split('\n')[0],
      settings: { durationSeconds, repetitions, concurrencies: reportConcurrencies, pipelining: 1, warmupSeconds: 3 },
      system: {
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpus: cpus().length,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
      },
      bundleSizes,
      summary,
      samples,
    }
    await writeFile(join(here, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
    await writeFile(join(here, 'RESULTS.md'), report(results))
  }
  finally {
    for (const server of servers)
      server.kill('SIGTERM')
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`)
  process.exitCode = 1
})
