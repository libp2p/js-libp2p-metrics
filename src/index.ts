import { pipe } from 'it-pipe'
import each from 'it-foreach'
import LRU from 'hashlru'
import { DefaultStats, StatsInit } from './stats.js'
import type { Metrics, Stats, TrackStreamOptions } from '@libp2p/interface-metrics'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { Startable } from '@libp2p/interfaces/startable'
import type { ConnectionManager } from '@libp2p/interface-connection-manager'

export const DEFAULT_INIT = {
  computeThrottleMaxQueueSize: 1000,
  computeThrottleTimeout: 2000,
  movingAverageIntervals: [
    60 * 1000, // 1 minute
    5 * 60 * 1000, // 5 minutes
    15 * 60 * 1000 // 15 minutes
  ],
  maxOldPeersRetention: 50
}

const initialCounters: ['dataReceived', 'dataSent'] = [
  'dataReceived',
  'dataSent'
]

const directionToEvent = {
  in: 'dataReceived',
  out: 'dataSent'
}

export interface OnMessageOptions {
  remotePeer: PeerId
  protocol?: string
  direction: 'in' | 'out'
  dataLength: number
}

export interface DefaultMetricsInit {
  computeThrottleMaxQueueSize: number
  computeThrottleTimeout: number
  movingAverageIntervals: number[]
  maxOldPeersRetention: number
}

export interface DefaultMetricsComponents {
  connectionManager: ConnectionManager
}

export class DefaultMetrics implements Metrics, Startable {
  public globalStats: DefaultStats

  private readonly peerStats: Map<string, DefaultStats>
  private readonly protocolStats: Map<string, DefaultStats>
  private readonly oldPeers: ReturnType<typeof LRU>
  private running: boolean
  private readonly statsInit: StatsInit
  private readonly components: DefaultMetricsComponents

  constructor (components: DefaultMetricsComponents, init?: Partial<DefaultMetricsInit>) {
    this.statsInit = {
      ...DEFAULT_INIT,
      ...(init ?? {}),
      initialCounters
    }
    this.globalStats = new DefaultStats(this.statsInit)
    this.peerStats = new Map()
    this.protocolStats = new Map()
    this.oldPeers = LRU(init?.maxOldPeersRetention ?? DEFAULT_INIT.maxOldPeersRetention)
    this.running = false
    this._onMessage = this._onMessage.bind(this)
    this.components = components
  }

  isStarted () {
    return this.running
  }

  /**
   * Must be called for stats to saved. Any data pushed for tracking
   * will be ignored.
   */
  async start () {
    this.running = true

    this.components.connectionManager.addEventListener('peer:disconnect', (evt) => {
      this.onPeerDisconnected(evt.detail.remotePeer)
    })
  }

  /**
   * Stops all averages timers and prevents new data from being tracked.
   * Once `stop` is called, `start` must be called to resume stats tracking.
   */
  async stop () {
    if (!this.running) {
      return
    }

    this.running = false
    this.globalStats.stop()

    for (const stats of this.peerStats.values()) {
      stats.stop()
    }

    for (const stats of this.protocolStats.values()) {
      stats.stop()
    }
  }

  /**
   * Gets the global `Stats` object
   */
  getGlobal () {
    return this.globalStats
  }

  /**
   * Returns a list of `PeerId` strings currently being tracked
   */
  getPeers () {
    return Array.from(this.peerStats.keys())
  }

  /**
   * Returns the `Stats` object for the given `PeerId` whether it
   * is a live peer, or in the disconnected peer LRU cache.
   */
  forPeer (peerId: PeerId): Stats | undefined {
    const idString = peerId.toString()
    return this.peerStats.get(idString) ?? this.oldPeers.get(idString)
  }

  /**
   * Returns a list of all protocol strings currently being tracked
   */
  getProtocols (): string[] {
    return Array.from(this.protocolStats.keys())
  }

  /**
   * Returns the `Stats` object for the given `protocol`
   */
  forProtocol (protocol: string): Stats | undefined {
    return this.protocolStats.get(protocol)
  }

  /**
   * Should be called when all connections to a given peer
   * have closed. The `Stats` collection for the peer will
   * be stopped and moved to an LRU for temporary retention.
   */
  onPeerDisconnected (peerId: PeerId) {
    const idString = peerId.toString()
    const peerStats = this.peerStats.get(idString)

    if (peerStats != null) {
      peerStats.stop()

      this.peerStats.delete(idString)
      this.oldPeers.set(idString, peerStats)
    }
  }

  /**
   * Takes the metadata for a message and tracks it in the
   * appropriate categories. If the protocol is present, protocol
   * stats will also be tracked.
   */
  _onMessage (opts: OnMessageOptions) {
    if (!this.running) {
      return
    }

    const { remotePeer, protocol, direction, dataLength } = opts

    const key = directionToEvent[direction]

    let peerStats = this.forPeer(remotePeer)
    if (peerStats == null) {
      const stats = new DefaultStats(this.statsInit)
      this.peerStats.set(remotePeer.toString(), stats)
      peerStats = stats
    }

    // Peer and global stats
    peerStats.push(key, dataLength)
    this.globalStats.push(key, dataLength)

    // Protocol specific stats
    if (protocol != null) {
      let protocolStats = this.forProtocol(protocol)

      if (protocolStats == null) {
        const stats = new DefaultStats(this.statsInit)
        this.protocolStats.set(protocol, stats)
        protocolStats = stats
      }

      protocolStats.push(key, dataLength)
    }
  }

  /**
   * Replaces the `PeerId` string with the given `peerId`.
   * If stats are already being tracked for the given `peerId`, the
   * placeholder stats will be merged with the existing stats.
   *
   * @param {PeerId} placeholder - A peerId string
   * @param {PeerId} peerId
   * @returns {void}
   */
  updatePlaceholder (placeholder: PeerId, peerId: PeerId) {
    if (!this.running) {
      return
    }

    const placeholderString = placeholder.toString()
    const placeholderStats = this.peerStats.get(placeholderString) ?? this.oldPeers.get(placeholderString)
    const peerIdString = peerId.toString()
    const existingStats = this.peerStats.get(peerIdString) ?? this.oldPeers.get(peerIdString)
    let mergedStats = placeholderStats

    // If we already have stats, merge the two
    if (existingStats != null) {
      // If existing, merge
      mergedStats = mergeStats(existingStats, mergedStats)
      // Attempt to delete from the old peers list just in case it was tracked there
      this.oldPeers.remove(peerIdString)
    }

    this.peerStats.delete(placeholder.toString())
    this.peerStats.set(peerIdString, mergedStats)
    mergedStats.start()
  }

  /**
   * Tracks data running through a given Duplex Iterable `stream`. If
   * the `peerId` is not provided, a placeholder string will be created and
   * returned. This allows lazy tracking of a peer when the peer is not yet known.
   * When the `PeerId` is known, `Metrics.updatePlaceholder` should be called
   * with the placeholder string returned from here, and the known `PeerId`.
   */
  trackStream (opts: TrackStreamOptions): void {
    const { stream, remotePeer, protocol } = opts

    if (!this.running) {
      return
    }

    const source = stream.source
    stream.source = each(source, chunk => this._onMessage({
      remotePeer,
      protocol,
      direction: 'in',
      dataLength: chunk.byteLength
    }))

    const sink = stream.sink
    stream.sink = async source => {
      return await pipe(
        source,
        (source) => each(source, chunk => {
          this._onMessage({
            remotePeer,
            protocol,
            direction: 'out',
            dataLength: chunk.byteLength
          })
        }),
        sink
      )
    }
  }

  registerMetric (name: string, opts: any): any {
    throw new Error('Not implemented')
  }

  registerMetricGroup (name: string, opts: any): any {
    throw new Error('Not implemented')
  }
}

/**
 * Merges `other` into `target`. `target` will be modified
 * and returned
 */
function mergeStats (target: DefaultStats, other: DefaultStats) {
  target.stop()
  other.stop()

  // Merge queues
  target.queue = [...target.queue, ...other.queue]

  // TODO: how to merge moving averages?
  return target
}
