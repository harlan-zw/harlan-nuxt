declare module '#wide-events/config' {
  const config: {
    console: boolean
    drain: boolean
    exclude?: RegExp
    sampling?: {
      debug?: number
      duration?: number
      error?: number
      info?: number
      status?: number
      warn?: number
    }
    service?: string
  }
  export default config
}
