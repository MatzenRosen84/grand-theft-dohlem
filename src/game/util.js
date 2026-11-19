import * as THREE from 'three'

// small seeded generator so the world looks the same on every load
export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a, b, t) => a + (b - a) * t
export const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

// flat [x, z, x, z, ...] ring helpers
export function ringArea(p) {
  let s = 0
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n
    s += p[i] * p[j + 1] - p[j] * p[i + 1]
  }
  return s / 2
}

export function inRing(p, x, z) {
  let inside = false
  for (let i = 0, n = p.length, j = n - 2; i < n; j = i, i += 2) {
    const zi = p[i + 1]
    const zj = p[j + 1]
    if (zi > z !== zj > z && x < ((p[j] - p[i]) * (z - zi)) / (zj - zi) + p[i]) inside = !inside
  }
  return inside
}

export function inArea(area, x, z) {
  if (!inRing(area.p, x, z)) return false
  if (area.holes) for (const h of area.holes) if (inRing(h, x, z)) return false
  return true
}

export function ringBounds(p) {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < minX) minX = p[i]
    if (p[i] > maxX) maxX = p[i]
    if (p[i + 1] < minZ) minZ = p[i + 1]
    if (p[i + 1] > maxZ) maxZ = p[i + 1]
  }
  return { minX, minZ, maxX, maxZ }
}

// Collects triangles into one geometry. Normals are per face.
export class GeoBuilder {
  constructor() {
    this.pos = []
    this.nor = []
    this.uv = []
    this.col = []
  }

  // a, b, c: [x, y, z]; ua..uc: [u, v]; hint: rough direction the face should look
  tri(a, b, c, ua, ub, uc, color, hint) {
    const e1x = b[0] - a[0]
    const e1y = b[1] - a[1]
    const e1z = b[2] - a[2]
    const e2x = c[0] - a[0]
    const e2y = c[1] - a[1]
    const e2z = c[2] - a[2]
    let nx = e1y * e2z - e1z * e2y
    let ny = e1z * e2x - e1x * e2z
    let nz = e1x * e2y - e1y * e2x
    const len = Math.hypot(nx, ny, nz)
    if (len < 1e-7) return
    nx /= len
    ny /= len
    nz /= len
    if (hint && nx * hint[0] + ny * hint[1] + nz * hint[2] < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
      const t = b
      b = c
      c = t
      const tu = ub
      ub = uc
      uc = tu
    }
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
    this.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
    this.uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1])
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b)
  }

  build() {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2))
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3))
    return g
  }
}
