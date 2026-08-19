declare module '#comark-content/components' {
  import type { Component } from 'vue'

  const components: Record<string, { name: string, component: Component }>
  export default components
}
