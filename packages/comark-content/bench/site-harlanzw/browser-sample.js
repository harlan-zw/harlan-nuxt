const targetUrl = '__TARGET_URL__'
const variant = '__VARIANT__'
const sample = __SAMPLE__

const page = await browser.newPage()
const consoleErrors = []
const pageErrors = []
page.on('console', (message) => {
  if (message.type() === 'error')
    consoleErrors.push(message.text())
})
page.on('pageerror', error => pageErrors.push(String(error)))

await page.setViewportSize({ width: 390, height: 844 })
await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
const cdp = await page.context().newCDPSession(page)
await cdp.send('Network.enable')
await cdp.send('Network.clearBrowserCache')
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
await cdp.send('Network.setBypassServiceWorker', { bypass: true })
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 40,
  downloadThroughput: 4000000,
  uploadThroughput: 1000000,
  connectionType: 'cellular4g',
})
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })

const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.evaluate(() => {
  window.__comarkBenchmark = {
    cls: 0,
    events: [],
    lcp: null,
  }
  new PerformanceObserver((list) => {
    const entries = list.getEntries()
    const entry = entries[entries.length - 1]
    window.__comarkBenchmark.lcp = entry
      ? {
          element: entry.element?.tagName || '',
          size: entry.size,
          startTimeMs: entry.startTime,
          url: entry.url || '',
        }
      : null
  }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!entry.hadRecentInput)
        window.__comarkBenchmark.cls += entry.value
    }
  }).observe({ type: 'layout-shift', buffered: true })
  new PerformanceObserver((list) => {
    window.__comarkBenchmark.events.push(...list.getEntries().map(entry => ({
      duration: entry.duration,
      interactionId: entry.interactionId,
      name: entry.name,
      processingEnd: entry.processingEnd,
      processingStart: entry.processingStart,
      startTime: entry.startTime,
      target: entry.target?.getAttribute?.('aria-label') || entry.target?.tagName || '',
    })))
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 })
})
await page.waitForLoadState('networkidle')
await page.waitForTimeout(1000)
const interactionTarget = page.locator('button').first()
const interactionTargetCount = await interactionTarget.count()
if (interactionTargetCount) {
  await interactionTarget.click()
  await page.waitForTimeout(500)
}

const metrics = await page.evaluate((sampleNumber) => {
  const state = window.__comarkBenchmark
  const navigation = performance.getEntriesByType('navigation')[0]
  const paints = performance.getEntriesByType('paint')
  const fcp = paints.find(entry => entry.name === 'first-contentful-paint')
  const interactions = new Map()
  for (const event of state.events) {
    if (!event.interactionId)
      continue
    const current = interactions.get(event.interactionId)
    if (!current || event.duration > current.duration)
      interactions.set(event.interactionId, event)
  }
  const interaction = [...interactions.values()].sort((left, right) => right.duration - left.duration)[0]
  const resources = performance.getEntriesByType('resource')
  return {
    cls: state.cls,
    domContentLoadedMs: navigation.domContentLoadedEventEnd,
    fcpMs: fcp?.startTime ?? null,
    interaction: interaction
      ? {
          durationMs: interaction.duration,
          inputDelayMs: interaction.processingStart - interaction.startTime,
          presentationDelayMs: interaction.startTime + interaction.duration - interaction.processingEnd,
          processingDurationMs: interaction.processingEnd - interaction.processingStart,
          target: interaction.target,
        }
      : null,
    lcp: state.lcp,
    loadMs: navigation.loadEventEnd,
    requests: resources.length + 1,
    resourceNames: sampleNumber === 1 ? resources.map(entry => new URL(entry.name).pathname) : undefined,
    resourceDecodedBytes: resources.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
    resourceTransferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
    ttfbMs: navigation.responseStart,
  }
}, sample)

const screenshot = sample === 1
  ? await saveScreenshot(await page.screenshot({ fullPage: true }), `comark-content-harlanzw-${variant}.png`)
  : null
const result = {
  variant,
  sample,
  status: response?.status() ?? 0,
  route: new URL(targetUrl).pathname,
  assertions: {
    heading: await page.locator('h1').count(),
    prose: await page.locator('.prose').count(),
    rawContentTags: await page.locator('postlist, projectlist, contentrenderer').count(),
  },
  consoleErrors,
  pageErrors,
  screenshot,
  metrics,
}
console.log(`__COMARK_SITE_BENCHMARK__${JSON.stringify(result)}`)
