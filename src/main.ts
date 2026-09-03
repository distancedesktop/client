import './style.css'
import type { ConnectionConfig } from './types'
import { Sidebar, loadConnections, saveConnections } from './ui/sidebar'
import { StreamPanel } from './ui/stream'
import { DebugOverlay } from './ui/debug'
import { $, debugLog } from './util'

const sidebarEl = $('#sidebar')
const placeholderEl = $('#stream-placeholder')
const streamPanelEl = $('#stream-panel')
const debugEl = $('#debug-overlay')

const debugOverlay = new DebugOverlay(debugEl)
void debugOverlay

let activePanel: StreamPanel | null = null
let activeId: string | null = null

const sidebar = new Sidebar(sidebarEl, {
  onSelect(config: ConnectionConfig) {
    if (activeId === config.id) return
    destroyPanel()
    activeId = config.id
    placeholderEl.classList.add('hidden')
    streamPanelEl.classList.remove('hidden')
    sidebar.updateStatus(config.id, 'connecting')
    activePanel = new StreamPanel(streamPanelEl, config, {
      onStatusChange(status: string) {
        sidebar.updateStatus(config.id, status)
      },
      onError(message: string) {
        debugLog('Error:', message)
      },
      onConfigChange() {
        sidebar.reload()
      },
      onBack() {
        destroyPanel()
        activeId = null
        streamPanelEl.classList.add('hidden')
        placeholderEl.classList.remove('hidden')
      }
    })
  },
  onDelete(id: string) {
    const conns = loadConnections().filter(c => c.id !== id)
    saveConnections(conns)
    if (activeId === id) {
      destroyPanel()
      activeId = null
      streamPanelEl.classList.add('hidden')
      placeholderEl.classList.remove('hidden')
    }
    sidebar.setConnections(conns)
  },
  onAdd(config: ConnectionConfig) {
    const conns = loadConnections()
    conns.push(config)
    saveConnections(conns)
    sidebar.setConnections(conns)
  }
})

sidebar.render()

function destroyPanel(): void {
  if (activePanel) {
    activePanel.destroy()
    activePanel = null
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.key === '~' || e.key === '`') && activePanel) {
    activePanel.toggleStats()
  }
})
