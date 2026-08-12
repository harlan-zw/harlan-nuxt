<script setup lang="ts">
const nuxtApp = useNuxtApp()

function addError() {
  return nuxtApp.callHook('nuxt-dx:issue', {
    kind: 'error',
    message: 'The profile query returned an invalid response.',
  })
}

function addWarning() {
  return nuxtApp.callHook('nuxt-dx:issue', {
    kind: 'warning',
    message: 'The profile query exceeded its development budget.',
  })
}
</script>

<template>
  <main>
    <p>Nuxt DX</p>
    <h1>Error overlay playground</h1>
    <div>
      <button type="button" @click="addError">
        Add error
      </button>
      <button type="button" @click="addWarning">
        Add warning
      </button>
    </div>
  </main>
</template>

<style scoped>
:global(body) {
  margin: 0;
  background: #0b0f17;
  color: #e2e8f0;
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Code", monospace;
}

main {
  display: grid;
  place-content: center;
  min-height: 100vh;
  padding: 2rem;
  text-align: center;
}

p {
  margin: 0;
  color: #94a3b8;
  font-size: 0.75rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0.5rem 0 1.5rem;
  font-size: clamp(1.75rem, 5vw, 3rem);
}

div {
  display: flex;
  justify-content: center;
  gap: 0.75rem;
}

button {
  min-height: 2.75rem;
  padding: 0.625rem 1rem;
  border: 1px solid rgb(148 163 184 / 35%);
  border-radius: 0.75rem;
  background: rgb(30 41 59 / 55%);
  color: inherit;
  cursor: pointer;
}

button:focus-visible {
  outline: 2px solid #f8fafc;
  outline-offset: 2px;
}
</style>
