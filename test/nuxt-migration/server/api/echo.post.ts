import { defineEventHandler, readBody } from 'nuxt/server'

export default defineEventHandler(event => readBody(event))
