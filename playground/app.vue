<script setup lang="ts">
const { data, displayData, status } = await useNuxtQuery<{ message: string }>('/api/hello', {
  key: 'hello',
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
