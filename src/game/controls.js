import { clamp } from './util.js'

// Free camera for looking around the map: it circles a point on the ground.
// Drag to turn, right-drag or WASD to move, wheel to zoom, Q/E to rotate.
// With `follow` set it becomes a chase camera instead.
export class OrbitRig {
  constructor(camera, dom, groundAt, limit) {
    this.camera = camera
    this.dom = dom
    this.groundAt = groundAt
    this.limit = limit
    // yaw 0 looks north, positive turns east
    this.goal = { x: 0, z: 0, yaw: -0.5, pitch: 0.5, dist: 700 }
    this.now = { ...this.goal }
    this.target = { x: 0, y: 0, z: 0 }
    this.keys = new Set()
    this.drag = null
    this.follow = null // set to an object with x, y, z, yaw (the car) to chase it
    this.idle = 0

    this.onKeyDown = (e) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
      this.keys.add(e.code)
    }
    this.onKeyUp = (e) => this.keys.delete(e.code)
    this.onBlur = () => this.keys.clear()
    this.onDown = (e) => {
      this.drag = { x: e.clientX, y: e.clientY, pan: e.button !== 0 || e.shiftKey }
      dom.setPointerCapture(e.pointerId)
    }
    this.onMove = (e) => {
      if (!this.drag) return
      const dx = e.clientX - this.drag.x
      const dy = e.clientY - this.drag.y
      this.drag.x = e.clientX
      this.drag.y = e.clientY
      this.idle = 0
      if (this.drag.pan && !this.follow) {
        this.move(-dx * this.goal.dist * 0.0016, dy * this.goal.dist * 0.0016)
      } else {
        this.goal.yaw -= dx * 0.005
        this.goal.pitch = clamp(this.goal.pitch + dy * 0.004, 0.06, 1.5)
      }
    }
    this.onUp = () => (this.drag = null)
    this.onWheel = (e) => {
      e.preventDefault()
      this.goal.dist = clamp(this.goal.dist * Math.exp(e.deltaY * 0.0012), 4.5, 3500)
    }
    this.onMenu = (e) => e.preventDefault()

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    dom.addEventListener('pointerdown', this.onDown)
    dom.addEventListener('pointermove', this.onMove)
    dom.addEventListener('pointerup', this.onUp)
    dom.addEventListener('pointercancel', this.onUp)
    dom.addEventListener('wheel', this.onWheel, { passive: false })
    dom.addEventListener('contextmenu', this.onMenu)
  }

  // right/forward in metres, relative to where the camera looks
  move(right, forward) {
    const g = this.goal
    const s = Math.sin(g.yaw)
    const c = Math.cos(g.yaw)
    g.x = clamp(g.x + c * right + s * forward, -this.limit, this.limit)
    g.z = clamp(g.z + s * right - c * forward, -this.limit, this.limit)
  }

  update(dt) {
    const k = this.keys
    const g = this.goal
    const n = this.now
    const f = this.follow
    if (f) {
      g.x = n.x = f.x
      g.z = n.z = f.z
      // swing back behind the car once the mouse has been left alone for a moment
      this.idle += dt
      if (this.idle > 1.2 && !this.drag) {
        const d = f.yaw - g.yaw
        g.yaw += Math.atan2(Math.sin(d), Math.cos(d)) * (1 - Math.exp(-dt * 3.5))
      }
    } else {
      const speed = (g.dist * 0.9 + 12) * (k.has('ShiftLeft') || k.has('ShiftRight') ? 3 : 1) * dt
      const fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0)
      const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0)
      if (fwd || side) this.move(side * speed, fwd * speed)
      g.yaw += ((k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0)) * dt * 1.4
    }

    // ease towards the goal
    const t = 1 - Math.exp(-dt * 9)
    for (const key of ['x', 'z', 'yaw', 'pitch', 'dist']) n[key] += (g[key] - n[key]) * t

    const tg = this.target
    tg.x = n.x
    tg.z = n.z
    tg.y = f ? f.y + 1.1 : this.groundAt(n.x, n.z) + 1.6
    const flat = Math.cos(n.pitch) * n.dist
    const cam = this.camera
    cam.position.set(tg.x - Math.sin(n.yaw) * flat, tg.y + Math.sin(n.pitch) * n.dist, tg.z + Math.cos(n.yaw) * flat)
    // never dip below the hills
    const floor = this.groundAt(cam.position.x, cam.position.z) + 2.5
    if (cam.position.y < floor) cam.position.y = floor
    cam.lookAt(tg.x, tg.y, tg.z)
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    const d = this.dom
    d.removeEventListener('pointerdown', this.onDown)
    d.removeEventListener('pointermove', this.onMove)
    d.removeEventListener('pointerup', this.onUp)
    d.removeEventListener('pointercancel', this.onUp)
    d.removeEventListener('wheel', this.onWheel)
    d.removeEventListener('contextmenu', this.onMenu)
  }
}
