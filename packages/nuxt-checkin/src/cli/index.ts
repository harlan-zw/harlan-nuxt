#!/usr/bin/env node
import process from 'node:process'
import { runCli } from './run'

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Check command failed.'}\n`)
  process.exitCode = 2
})
