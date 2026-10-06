import { defineEventHandler } from 'nuxt/server'
import { telemetryEvidence } from '../utils/telemetry-evidence'

export default defineEventHandler(() => telemetryEvidence)
