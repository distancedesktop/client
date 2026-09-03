import { formatBitrate } from '../util'

export interface StatsView {
  fps: number
  rtt: number
  bitrate: number
  width: number
  height: number
  online: boolean
}

export class StatsOverlay {
  public el: HTMLElement
  private visible = false
  private last: StatsView = { fps: 0, rtt: 0, bitrate: 0, width: 0, height: 0, online: false }

  constructor() {
    this.el = document.createElement('div')
    this.el.className = 'stats hidden'
  }

  toggle(): void {
    this.visible = !this.visible
    this.el.classList.toggle('hidden', !this.visible)
    if (this.visible) this.render()
  }

  show(): void {
    this.visible = true
    this.el.classList.remove('hidden')
    this.render()
  }

  update(v: Partial<StatsView>): void {
    this.last = { ...this.last, ...v }
    if (this.visible) this.render()
  }

  private row(k: string, v: string, cls = ''): string {
    return `<div class="stat"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`
  }

  private render(): void {
    const v = this.last
    const rttCls = v.rtt > 150 ? 'crit' : v.rtt > 60 ? 'bad' : ''
    const fpsCls = v.fps === 0 ? 'bad' : ''
    const bitrateCls = v.bitrate === 0 ? 'bad' : ''
    this.el.innerHTML =
      this.row('fps', v.fps ? `${v.fps}` : '\u2014', fpsCls) +
      this.row('rtt', v.rtt ? `${v.rtt} ms` : '\u2014', rttCls) +
      this.row('bitrate', v.bitrate ? formatBitrate(v.bitrate) : '\u2014', bitrateCls) +
      this.row('res', v.width ? `${v.width}\u00d7${v.height}` : '\u2014') +
      this.row('link', v.online ? 'up' : 'down', v.online ? '' : 'crit')
  }
}
