declare module '#wide-events/config' {
  const config: {
    console: boolean
    drain: boolean
    exclude?: RegExp
    sampling?: {
      debug?: number
      error?: number
      info?: number
      keep?: { duration?: number, status?: number }[]
      warn?: number
    }
    service?: string
  }
  export default config
}
