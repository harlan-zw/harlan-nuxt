<script setup lang="ts">
const { data, displayData, status } = await useNuxtQuery<{ message: string }>('/api/hello', {
  key: 'hello',
})

// Realtime demo: a query kept fresh by a subscription instead of polling. The
// `source` here is a mock transport (an interval) — swap it for a real channel
// composable or `nuxtWebSocketSource('wss://…')`. Each "message" invalidates the
// query's key, so the server counter visibly increments without a page reload.
const countQuery = useNuxtQuery<{ count: number }>('/api/realtime-count', {
  key: 'realtime-count',
  staleTime: Infinity, // freshness is driven by the subscription, not SWR
})

const sub = useNuxtSubscription<{ tick: number }>({
  source: (ctx) => {
    let n = 0
    const id = setInterval(() => ctx.push({ tick: ++n }), 2000)
    return () => clearInterval(id)
  },
  onMessage: () => invalidateNuxtQueries('realtime-count'),
})

const probes = [
  {
    href: '/api/telemetry/slow',
    label: 'Slow fetch',
    note: 'One 150ms upstream call. Expect `slow fetch` in the server log.',
  },
  {
    href: '/api/telemetry/waterfall',
    label: 'Waterfall',
    note: 'Two sequential 150ms upstream calls. Expect `slow fetch` and `fetch waterfall`.',
  },
  {
    href: '/api/telemetry/parallel',
    label: 'Parallel fan-out',
    note: 'Two parallel 150ms upstream calls. Expect slow fetch logs, no waterfall warning.',
  },
]
</script>

<template>
  <main>
    <h1>Nuxt Use Query</h1>
    <pre>{{ { data, displayData, status } }}</pre>

    <h2>Realtime Subscription</h2>
    <p>A subscription invalidates the counter query every 2s; the count increments without polling or reload.</p>
    <pre>{{ { subscription: sub.status.value, count: countQuery.data.value?.count } }}</pre>

    <h2>Fetch Telemetry</h2>
    <p>The initial hello query emits Nuxt app hook logs. Open the Nuxt server log, then hit each fetch probe.</p>
    <ul>
      <li v-for="probe in probes" :key="probe.href">
        <a :href="probe.href" target="_blank">{{ probe.label }}</a>
        <span>{{ probe.note }}</span>
      </li>
    </ul>
  </main>
</template>
