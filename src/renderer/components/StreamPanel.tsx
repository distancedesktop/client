import { useRef, useEffect, useCallback, useState } from 'react'
import type { DisplayInfo, ConnectionConfig } from '../lib/types'
import { WebTransportClient, type StreamEvent } from '../lib/webtransport-client'
import { MoqIntegration } from '../lib/moq-integration'
import { debugLog } from '../lib/debug'

interface Props {
  config: ConnectionConfig
  onStatusChange: (id: string, status: 'disconnected' | 'connecting' | 'connected' | 'streaming') => void
  onError: (id: string, message: string) => void
  onUpdateFingerprint?: (id: string, fingerprint: string) => void
}

export function StreamPanel({ config, onStatusChange, onError, onUpdateFingerprint }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<WebTransportClient | null>(null)
  const moqRef = useRef<MoqIntegration | null>(null)
  const [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [selectedDisplayId, setSelectedDisplayId] = useState<number>(0)
  const [streamInfo, setStreamInfo] = useState<{ width: number; height: number; codec: string } | null>(null)

  useEffect(() => {
    const moq = new MoqIntegration()
    moqRef.current = moq

    const client = new WebTransportClient(config, (event: StreamEvent) => {
      debugLog('StreamPanel: event:', event.type, event)
      switch (event.type) {
        case 'connecting':
          onStatusChange(config.id, 'connecting')
          break
        case 'connected': {
          debugLog('StreamPanel: connected, requesting display list')
          onStatusChange(config.id, 'connected')
          client.listDisplays()

          const wt = client.getTransport()
          if (wt) {
            moq.connect(wt, client.getUrl()).catch((err) => {
              debugLog('StreamPanel: MoQ connect error:', err)
            })
          }
          break
        }
        case 'displays':
          debugLog('StreamPanel: received', event.displays.length, 'displays')
          setDisplays(event.displays)
          if (event.displays.length > 0) {
            setSelectedDisplayId(event.displays[0].id)
          }
          break
        case 'started': {
          debugLog('StreamPanel: stream started', event.width, 'x', event.height, event.codec)
          setStreamInfo({ width: event.width, height: event.height, codec: event.codec })
          onStatusChange(config.id, 'streaming')

          const canvas = canvasRef.current
          if (canvas && moq.connected) {
            moq.startDisplay(canvas, selectedDisplayId)
          } else {
            debugLog('StreamPanel: MoQ not ready yet, will retry in 500ms')
            setTimeout(() => {
              if (canvas && moqRef.current?.connected) {
                moqRef.current.startDisplay(canvas, selectedDisplayId)
              }
            }, 500)
          }
          break
        }
        case 'stopped':
        case 'stream-ended':
          debugLog('StreamPanel: stream ended')
          setStreamInfo(null)
          setDisplays([])
          moq.stopDisplay()
          onStatusChange(config.id, 'connected')
          break
        case 'error':
          debugLog('StreamPanel: error event:', event.message)
          onError(config.id, event.message)
          break
        case 'disconnected':
          debugLog('StreamPanel: disconnected')
          setStreamInfo(null)
          setDisplays([])
          moq.close()
          onStatusChange(config.id, 'disconnected')
          break
        case 'fingerprint-refresh':
          debugLog('StreamPanel: fingerprint refresh:', event.fingerprint)
          onUpdateFingerprint?.(config.id, event.fingerprint)
          break
      }
    })
    streamRef.current = client
    client.connect()

    return () => {
      moq.close()
      client.disconnect()
    }
  }, [config, onStatusChange, onError, onUpdateFingerprint])

  const handleStart = () => {
    streamRef.current?.startStream(selectedDisplayId)
  }

  const handleStop = () => {
    streamRef.current?.stopStream()
    moqRef.current?.stopDisplay()
    setStreamInfo(null)
  }

  return (
    <div className="stream-panel">
      {displays.length > 0 && !streamInfo && (
        <div className="display-selector">
          <label>Select display to stream:</label>
          <select value={selectedDisplayId} onChange={(e) => setSelectedDisplayId(Number(e.target.value))}>
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                Display {d.id} &mdash; {d.width}x{d.height}
                {d.refresh_rate ? ` @ ${Math.round(d.refresh_rate)}Hz` : ''}
              </option>
            ))}
          </select>
          <button className="start-btn" onClick={handleStart}>
            Start Stream
          </button>
        </div>
      )}

      {streamInfo && (
        <div className="stream-info-bar">
          <span>Streaming: {streamInfo.width}x{streamInfo.height} ({streamInfo.codec})</span>
          <button className="stop-btn" onClick={handleStop}>Stop</button>
        </div>
      )}

      <div className="canvas-container">
        <canvas ref={canvasRef} />
        {!streamInfo && !displays.length && (
          <div className="stream-placeholder">
            <p>Connected to {config.name}</p>
            <p className="subtle">Loading displays&hellip;</p>
          </div>
        )}
      </div>
    </div>
  )
}
