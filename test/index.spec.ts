import type { MetricOptions, Metric, MetricGroup, CalculatedMetricOptions, StopTimer } from '@libp2p/interface-metrics'
import { expect } from 'aegir/chai'
import { DefaultMetrics } from '../src/index.js'
import { mockConnectionManager, mockRegistrar } from '@libp2p/interface-mocks'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'

class DefaultMetric implements Metric {
  public value: number = 0

  update (value: number): void {
    this.value = value
  }

  increment (value = 1): void {
    this.value += value
  }

  decrement (value = 1): void {
    this.value -= value
  }

  reset (): void {
    this.value = 0
  }

  timer (): StopTimer {
    const start = Date.now()

    return () => {
      this.value = Date.now() - start
    }
  }
}

class DefaultGroupMetric implements MetricGroup {
  public values: Record<string, number> = {}

  update (values: Record<string, number>): void {
    Object.entries(values).forEach(([key, value]) => {
      this.values[key] = value
    })
  }

  increment (values: Record<string, number | unknown>): void {
    Object.entries(values).forEach(([key, value]) => {
      this.values[key] = this.values[key] ?? 0
      const inc = typeof value === 'number' ? value : 1

      this.values[key] += inc
    })
  }

  decrement (values: Record<string, number | unknown>): void {
    Object.entries(values).forEach(([key, value]) => {
      this.values[key] = this.values[key] ?? 0
      const dec = typeof value === 'number' ? value : 1

      this.values[key] -= dec
    })
  }

  reset (): void {
    this.values = {}
  }

  timer (key: string): StopTimer {
    const start = Date.now()

    return () => {
      this.values[key] = Date.now() - start
    }
  }
}

class TestMetrics extends DefaultMetrics {
  public metrics = new Map<string, any>()

  registerMetric (name: string, opts: CalculatedMetricOptions): void
  registerMetric (name: string, opts?: MetricOptions): Metric
  registerMetric (name: string, opts: any): any {
    if (name == null ?? name.trim() === '') {
      throw new Error('Metric name is required')
    }

    if (opts?.calculate != null) {
      // calculated metric
      this.metrics.set(name, opts.calculate)
      return
    }

    const metric = new DefaultMetric()
    this.metrics.set(name, metric)

    return metric
  }

  registerMetricGroup (name: string, opts: CalculatedMetricOptions): void
  registerMetricGroup (name: string, opts?: MetricOptions): MetricGroup
  registerMetricGroup (name: string, opts: any): any {
    if (name == null ?? name.trim() === '') {
      throw new Error('Metric name is required')
    }

    if (opts?.calculate != null) {
      // calculated metric
      this.metrics.set(name, opts.calculate)
      return
    }

    const metric = new DefaultGroupMetric()
    this.metrics.set(name, metric)

    return metric
  }
}

describe('default metrics', () => {
  it('should collect metrics', async () => {
    const metricName = 'test_my_metric'
    const metricValue = 5
    const network: any = {
      peerId: await createEd25519PeerId(),
      registrar: mockRegistrar()
    }
    const connectionManager = mockConnectionManager(network)

    const metrics = new TestMetrics({
      connectionManager
    })
    const metric = metrics.registerMetric(metricName)
    metric.update(metricValue)

    expect(metric).to.have.property('value', metricValue)
  })
})
