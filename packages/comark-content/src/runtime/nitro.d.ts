declare module '#imports' {
  export { defineEventHandler, readBody } from 'h3'
  export { useStorage } from 'nitropack/runtime'
  export function useRuntimeConfig(): { public: Record<string, unknown> }
}
