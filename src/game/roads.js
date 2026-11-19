import * as THREE from 'three'
import { roadTextures, normalFrom } from './textures.js'

// w: width in metres, tex: texture, len: metres per texture repeat along the road,
// lift: height above the ground (also the draw order), carve: level the ground underneath
const STYLES = {
  secondary: { w: 7, tex: 'major', len: 12, lift: 0.17, carve: true, street: true },
  tertiary: { w: 6.2, tex: 'major', len: 12, lift: 0.17, carve: true, street: true },
  primary: { w: 7.5, tex: 'major', len: 12, lift: 0.17, carve: true, street: true },
  unclassified: { w: 5, tex: 'asphalt', len: 8, lift: 0.15, carve: true, street: true },
  residential: { w: 5.5, tex: 'asphalt', len: 8, lift: 0.15, carve: true, street: true },
  living_street: { w: 4.6, tex: 'asphalt', len: 8, lift: 0.15, carve: true, street: true },
  service: { w: 3.4, tex: 'asphalt', len: 8, lift: 0.13, carve: true },
  track: { w: 2.8, tex: 'track', len: 6, lift: 0.11, carve: true },
  path: { w: 1.2, tex: 'path', len: 3, lift: 0.09 },
  footway: { w: 1.4, tex: 'path', len: 3, lift: 0.09 },
  bridleway: { w: 1.6, tex: 'path', len: 3, lift: 0.09 },
  steps: { w: 1.4, tex: 'path', len: 3, lift: 0.09 },
  rail: { w: 3.6, tex: 'rail', len: 2.4, lift: 0.14, carve: true },
}

const STEP = 3 // metres between ribbon cross-sections

function styleOf(road) {
  let s = STYLES[road.k]
  if (!s) return null
  if (road.k === 'track' && (road.grade === 'grade1' || road.surf === 'asphalt')) s = { ...s, tex: 'asphalt', w: 3 }
  if (road.k === 'service' && (road.svc === 'driveway' || road.svc === 'parking_aisle')) s = { ...s, w: 2.8 }
  return s
}

// Cuts every road into evenly spaced runs inside the play area and levels the
// terrain under the ones wide enough to drive on.
export function prepareRoads(map, hf) {
  const runs = []
  for (const road of map.roads) {
    const style = styleOf(road)
    if (!style) continue
    const p = road.p
    let cur = []
    const flush = () => {
      if (cur.length >= 4) runs.push({ road, style, pts: cur })
      cur = []
    }
    const add = (x, z) => (hf.contains(x, z, 2) ? cur.push(x, z) : flush())
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i]
      const dz = p[i + 3] - p[i + 1]
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STEP))
      for (let j = 0; j < n; j++) add(p[i] + (dx * j) / n, p[i + 1] + (dz * j) / n)
    }
    add(p[p.length - 2], p[p.length - 1])
    flush()
  }

  // height profile along each run, smoothed so roads don't follow every bump
  for (const run of runs) {
    const n = run.pts.length / 2
    let y = new Float32Array(n)
    for (let i = 0; i < n; i++) y[i] = hf.heightAt(run.pts[i * 2], run.pts[i * 2 + 1])
    for (let pass = 0; pass < 2; pass++) {
      const out = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let sum = 0
        let cnt = 0
        for (let d = -5; d <= 5; d++) {
          const j = i + d
          if (j < 0 || j >= n) continue
          sum += y[j]
          cnt++
        }
        out[i] = sum / cnt
      }
      y = out
    }
    run.y = y
  }

  hf.beginCarve()
  for (const run of runs) {
    if (!run.style.carve) continue
    const inner = run.style.w / 2 + 4
    for (let i = 0; i < run.y.length; i++) hf.carve(run.pts[i * 2], run.pts[i * 2 + 1], run.y[i], inner, inner + 8)
  }
  hf.endCarve()
  return runs
}

class Ribbon {
  constructor() {
    this.pos = []
    this.uv = []
    this.idx = []
  }

  add(pts, width, lift, texLen, hf) {
    const n = pts.length / 2
    const base = this.pos.length / 3
    const hw = width / 2
    let dist = 0
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2]
      const z = pts[i * 2 + 1]
      const a = Math.max(0, i - 1)
      const b = Math.min(n - 1, i + 1)
      let tx = pts[b * 2] - pts[a * 2]
      let tz = pts[b * 2 + 1] - pts[a * 2 + 1]
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl
      tz /= tl
      if (i > 0) dist += Math.hypot(x - pts[i * 2 - 2], z - pts[i * 2 - 1])
      const ax = x - tz * hw
      const az = z + tx * hw
      const bx = x + tz * hw
      const bz = z - tx * hw
      this.pos.push(ax, hf.heightAt(ax, az) + lift, az, bx, hf.heightAt(bx, bz) + lift, bz)
      this.uv.push(0, dist / texLen, 1, dist / texLen)
      if (i > 0) {
        const k = base + i * 2
        this.idx.push(k - 2, k, k - 1, k - 1, k, k + 1)
      }
    }
  }

  mesh(material, name) {
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    const nor = new Float32Array(this.pos.length)
    for (let i = 1; i < nor.length; i += 3) nor[i] = 1
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3))
    geo.setIndex(this.idx)
    const m = new THREE.Mesh(geo, material)
    m.receiveShadow = true
    m.name = name
    return m
  }
}

// nearBuildings(x, z) tells whether a point lies in the built-up part of the village
export function buildRoads(runs, map, hf, nearBuildings) {
  const group = new THREE.Group()
  group.name = 'roads'
  const ribbons = {}
  const ribbon = (key) => (ribbons[key] ??= new Ribbon())

  for (const run of runs) {
    const { style, pts } = run
    ribbon(style.tex).add(pts, style.w, style.lift, style.len, hf)

    // pavements where the street runs between houses
    if (style.street) {
      let hits = 0
      const n = pts.length / 2
      for (let i = 0; i < n; i++) if (nearBuildings(pts[i * 2], pts[i * 2 + 1])) hits++
      if (hits / n > 0.5) ribbon('sidewalk').add(pts, style.w + 3.4, 0.06, 1.6, hf)
    }
  }

  for (const w of map.waterways) {
    const pts = []
    const p = w.p
    for (let i = 0; i + 3 < p.length; i += 2) {
      const dx = p[i + 2] - p[i]
      const dz = p[i + 3] - p[i + 1]
      const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / STEP))
      for (let j = 0; j < n; j++) {
        const x = p[i] + (dx * j) / n
        const z = p[i + 1] + (dz * j) / n
        if (hf.contains(x, z, 2)) pts.push(x, z)
      }
    }
    if (pts.length >= 4) ribbon('water').add(pts, w.k === 'river' ? 5 : 1.8, 0.05, 4, hf)
  }

  // draw order follows the lift, polygon offset keeps distant roads from flickering
  const order = ['water', 'sidewalk', 'path', 'track', 'asphalt', 'rail', 'major']
  order.forEach((key, i) => {
    if (!ribbons[key]) return
    const map = roadTextures[key]()
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap: key === 'water' ? null : normalFrom(map, key === 'track' || key === 'rail' ? 3 : 1.6),
      roughness: key === 'water' ? 0.12 : key === 'asphalt' || key === 'major' ? 0.82 : 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1 - i,
      polygonOffsetUnits: -2 - i * 2,
    })
    const m = ribbons[key].mesh(mat, key)
    m.renderOrder = i + 1
    group.add(m)
  })
  return group
}

// Returns a function giving the direction from a point to the closest street,
// so houses can turn their front door towards it.
export function towardsStreet(runs) {
  const pts = []
  for (const run of runs) {
    if (!run.style.carve || run.style.tex === 'rail' || run.style.tex === 'track') continue
    for (let i = 0; i < run.pts.length; i += 4) pts.push(run.pts[i], run.pts[i + 1])
  }
  return (x, z) => {
    let bd = 90 * 90
    let bx = 0
    let bz = 0
    for (let i = 0; i < pts.length; i += 2) {
      const d = (pts[i] - x) ** 2 + (pts[i + 1] - z) ** 2
      if (d < bd) {
        bd = d
        bx = pts[i] - x
        bz = pts[i + 1] - z
      }
    }
    const len = Math.hypot(bx, bz)
    return len > 0 ? { x: bx / len, z: bz / len } : null
  }
}

// Named points along the streets, for the street name in the HUD.
export function streetIndex(runs) {
  const pts = []
  for (const run of runs) {
    const name = run.road.n ?? run.road.ref
    if (!name || run.road.k === 'rail') continue
    for (let i = 0; i < run.pts.length; i += 6) pts.push({ x: run.pts[i], z: run.pts[i + 1], name })
  }
  return (x, z, maxDist = 60) => {
    let best = null
    let bd = maxDist * maxDist
    for (const p of pts) {
      const d = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d < bd) {
        bd = d
        best = p.name
      }
    }
    return best
  }
}
