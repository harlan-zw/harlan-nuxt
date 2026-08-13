import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '../..')
const durationSeconds = Number(process.env.BENCH_DURATION ?? 20)
const repetitions = Number(process.env.BENCH_REPETITIONS ?? 3)
const concurrencies = [1, 32, 128]
const targets = {
  disabled: { fixture: join(here, 'disabled'), port: 43101 },
  enabled: { fixture: join(here, 'enabled'), port: 43102 },
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

function report(results) {
  const lines = [
    '# Nitro HTTP benchmark results',
    '',
    `Generated: ${results.generatedAt}`,
    '',
    `Runtime: Node ${results.system.node}, ${results.system.cpu}`,
    '',
    `Method: autocannon ${results.autocannonVersion}, ${durationSeconds}s, ${repetitions} repetitions, pipelining 1.`,
    '',
    '| Concurrency | Module | Requests/s | p50 | p99 | Throughput delta | p99 delta |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ]

  for (const connections of concurrencies) {
    const disabled = results.summary.disabled[String(connections)]
    const enabled = results.summary.enabled[String(connections)]
    const throughputDelta = (enabled.requestsPerSecond / disabled.requestsPerSecond - 1) * 100
    const p99Delta = (enabled.p99 / disabled.p99 - 1) * 100
    lines.push(`| ${connections} | disabled | ${fixed(disabled.requestsPerSecond, 0)} | ${fixed(disabled.p50)} ms | ${fixed(disabled.p99)} ms | baseline | baseline |`)
    lines.push(`| ${connections} | enabled | ${fixed(enabled.requestsPerSecond, 0)} | ${fixed(enabled.p50)} ms | ${fixed(enabled.p99)} ms | ${fixed(throughputDelta)}% | ${fixed(p99Delta)}% |`)
  }

  lines.push(
    '',
    'Each cell is the median of all repetitions. See `results.json` for raw autocannon output.',
    '',
  )
  return `${lines.join('\n')}\n`
}

async function main() {
  const servers = []

  try {
    await command('npx', ['-y', 'autocannon@8.0.0', '--version'])
    await build(targets.disabled)
    await build(targets.enabled)

    for (const target of Object.values(targets)) {
      const server = start(target)
      servers.push(server)
      await waitForServer(target)
    }

    const samples = []
    for (const connections of concurrencies) {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        const order = repetition % 2 === 0 ? ['disabled', 'enabled'] : ['enabled', 'disabled']
        for (const mode of order) {
          const target = targets[mode]
          await runLoad(target, connections, 3, false)
          const result = await runLoad(target, connections, durationSeconds, true)
          samples.push({ mode, connections, repetition, result })
          process.stdout.write(`${mode} c=${connections} run=${repetition + 1}: ${fixed(result.requests.average, 0)} requests/s\n`)
        }
      }
    }

    const summary = { disabled: {}, enabled: {} }
    for (const mode of Object.keys(targets)) {
      for (const connections of concurrencies) {
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
    const results = {
      generatedAt: new Date().toISOString(),
      commit: commit.trim(),
      dirty: true,
      autocannonVersion: autocannonVersion.trim(),
      settings: { durationSeconds, repetitions, concurrencies, pipelining: 1, warmupSeconds: 3 },
      system: {
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCpus: cpus().length,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
      },
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
