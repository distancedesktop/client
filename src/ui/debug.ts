import { getDebugLogs, onDebugLogUpdate } from '../util'

export class DebugOverlay {
  private root: HTMLElement
  private visible = false

  constructor(root: HTMLElement) {
    this.root = root
    this.root.className = 'debug-overlay hidden'

    window.addEventListener('keydown', (e) => {
      if (e.key === 'D' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
        this.toggle()
      }
    })

    onDebugLogUpdate(() => {
      if (this.visible) this.renderLogs()
    })
  }

  toggle(): void {
    this.visible = !this.visible
    this.root.classList.toggle('hidden', !this.visible)
    if (this.visible) this.render()
  }

  private render(): void {
    this.root.innerHTML = ''
    const bar = document.createElement('div')
    bar.className = 'debug-bar'

    const title = document.createElement('span')
    title.textContent = 'Debug Logs'

    const closeBtn = document.createElement('button')
    closeBtn.textContent = 'Close'
    closeBtn.addEventListener('click', () => this.toggle())

    bar.append(title, closeBtn)
    this.root.append(bar)

    const container = document.createElement('div')
    container.className = 'debug-log-container'
    this.root.append(container)

    this.renderLogs()
  }

  private renderLogs(): void {
    const container = this.root.querySelector('.debug-log-container')
    if (!container) return
    const logs = getDebugLogs()
    container.innerHTML = ''
    if (logs.length === 0) {
      container.textContent = 'No logs yet.'
      return
    }
    for (const line of logs) {
      const div = document.createElement('div')
      div.textContent = line
      container.append(div)
    }
  }
}
