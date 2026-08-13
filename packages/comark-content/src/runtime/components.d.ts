declare module '#comark-content/components' {
  import type { Component } from 'vue'

  const loaders: Record<string, { name: string, load: () => Promise<Component> }>
  export default loaders
}
