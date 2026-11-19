// Loads the files written by scripts/fetch-map.mjs.

export class Heightfield {
  constructor(data, grid, size) {
    this.data = data
    this.grid = grid
    this.size = size
    this.half = size / 2
    this.cell = size / (grid - 1)
  }

  contains(x, z, margin = 0) {
    const h = this.half - margin
    return x > -h && x < h && z > -h && z < h
  }

  // Interpolates exactly like the terrain mesh triangles, so anything placed
  // with this sits on the visible surface.
  heightAt(x, z) {
    const g = this.grid
    const d = this.data
    let fx = (x + this.half) / this.cell
    let fz = (z + this.half) / this.cell
    const max = g - 1.0001
    fx = fx < 0 ? 0 : fx > max ? max : fx
    fz = fz < 0 ? 0 : fz > max ? max : fz
    const ix = fx | 0
    const iz = fz | 0
    const u = fx - ix
    const v = fz - iz
    const i = iz * g + ix
    const a = d[i]
    const e = d[i + 1]
    const b = d[i + g]
    const c = d[i + g + 1]
    return u + v <= 1 ? a + u * (e - a) + v * (b - a) : c + (1 - u) * (b - c) + (1 - v) * (e - c)
  }

  // --- levelling the ground under roads -------------------------------

  beginCarve() {
    const n = this.data.length
    this._sum = new Float32Array(n)
    this._w = new Float32Array(n)
    this._max = new Float32Array(n)
  }

  // pull the ground towards height y: fully within `inner` metres, fading out to `outer`
  carve(x, z, y, inner, outer) {
    const c = this.cell
    const g = this.grid
    const x0 = Math.max(0, Math.ceil((x - outer + this.half) / c))
    const x1 = Math.min(g - 1, Math.floor((x + outer + this.half) / c))
    const z0 = Math.max(0, Math.ceil((z - outer + this.half) / c))
    const z1 = Math.min(g - 1, Math.floor((z + outer + this.half) / c))
    for (let iz = z0; iz <= z1; iz++) {
      const dz = iz * c - this.half - z
      for (let ix = x0; ix <= x1; ix++) {
        const dx = ix * c - this.half - x
        const dist = Math.hypot(dx, dz)
        if (dist >= outer) continue
        let w = dist <= inner ? 1 : 1 - (dist - inner) / (outer - inner)
        w = w * w * (3 - 2 * w)
        const i = iz * g + ix
        this._sum[i] += y * w
        this._w[i] += w
        if (w > this._max[i]) this._max[i] = w
      }
    }
  }

  endCarve() {
    const d = this.data
    for (let i = 0; i < d.length; i++) {
      if (this._w[i] > 0) d[i] += (this._sum[i] / this._w[i] - d[i]) * this._max[i]
    }
    this.roadMask = this._max
    this._sum = this._w = this._max = null
  }

  // true on and right next to carved roads
  nearRoad(x, z) {
    if (!this.roadMask) return false
    const ix = Math.round((x + this.half) / this.cell)
    const iz = Math.round((z + this.half) / this.cell)
    if (ix < 0 || iz < 0 || ix >= this.grid || iz >= this.grid) return false
    return this.roadMask[iz * this.grid + ix] > 0.75
  }
}

export async function loadMap() {
  const base = import.meta.env.BASE_URL + 'data/'
  const get = async (file, type) => {
    const res = await fetch(base + file)
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status} (zuerst "npm run fetch-map" ausführen)`)
    return res[type]()
  }
  const [map, innerBuf, outerBuf] = await Promise.all([
    get('map.json', 'json'),
    get('height.bin', 'arrayBuffer'),
    get('outer.bin', 'arrayBuffer'),
  ])

  const { meta } = map
  const raw = new Uint16Array(innerBuf)
  const mid = (meta.grid - 1) / 2
  // world y = 0 is the ground at the map centre
  const baseH = meta.minH + raw[mid * meta.grid + mid] / 10
  const decode = (u16) => {
    const f = new Float32Array(u16.length)
    for (let i = 0; i < f.length; i++) f[i] = meta.minH + u16[i] / 10 - baseH
    return f
  }

  return {
    map,
    baseH,
    terrain: new Heightfield(decode(raw), meta.grid, meta.size),
    outer: new Heightfield(decode(new Uint16Array(outerBuf)), meta.outerGrid, meta.outerSize),
  }
}
