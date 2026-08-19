export interface PerformanceBench {
  comparisonRme?: number
  id: string
  informational?: boolean
  kind: 'alloc' | 'size' | 'time'
  name: string
  rme?: number
  value: number
}

export interface PerformanceRun {
  benches: PerformanceBench[]
}

export function renderPerformanceReport(
  baseRun: PerformanceRun | null,
  pullRequestRun: PerformanceRun,
  baseLabel?: string,
): string
