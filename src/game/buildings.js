import * as THREE from 'three'
import { GeoBuilder, rng, ringArea } from './util.js'
import { wallTextures, roofTextures, normalFrom } from './textures.js'

// Houses the way they stand in the Westerwald: rendered walls in white and
// pale tones on a dark basalt plinth, steep roofs in slate grey or red tile
// with a bit of overhang, slate hung on the weather (west) side, and
// half-timbered houses in the old middle of the village.

const WALLS = [0xf4f1e9, 0xf4f1e9, 0xefeadc, 0xf7f5ef, 0xe9e4d6, 0xe3e1da, 0xf1e8cf, 0xe8dcc4, 0xdfe5e2, 0xeed9c8]
const SLATE_ROOFS = [0x646b74, 0x5a6068, 0x6e737a, 0x54585e]
const TILE_ROOFS = [0xb5573c, 0xa84e36, 0xc0634a, 0x8f4433, 0x9c5a44]
const STOREY = 2.9
const TILE_W = 3.2
const PLINTH = 0.5
const OVERHANG = 0.4

const SMALL = ['shed', 'garage', 'garages', 'carport', 'roof', 'hut', 'greenhouse']
const HALLS = ['industrial', 'retail', 'sports_hall', 'warehouse', 'commercial', 'barn', 'farm_auxiliary', 'supermarket']
const PUBLIC = ['school', 'kindergarten', 'fire_station', 'apartments', 'civic', 'public']

// wall height, roof height and kind, guessed from the OSM tags and the footprint
function dimensions(b, area, halfW, rand) {
  const t = b.t
  let wall, roof, kind = 'house'
  if (t === 'church') {
    wall = 9
    roof = Math.min(halfW * 1.1, 8)
    kind = 'church'
  } else if (t === 'chapel') {
    wall = 4
    roof = Math.min(halfW * 1.1, 3.5)
    kind = 'church'
  } else if (SMALL.includes(t) || area < 45) {
    wall = 2.5 + rand() * 0.4
    roof = rand() < 0.4 ? 0.2 : Math.min(halfW * 0.45, 1.3)
    kind = 'shed'
  } else if (HALLS.includes(t) || area > 650) {
    wall = 5.5 + rand() * 2
    roof = Math.min(halfW * 0.22, 2.2)
    kind = 'hall'
  } else if (PUBLIC.includes(t)) {
    wall = 2 * STOREY + PLINTH
    roof = Math.min(halfW * 0.6, 3.5)
  } else {
    const levels = b.lv ?? (rand() < 0.7 ? 2 : 1)
    wall = levels * STOREY + PLINTH
    // steep roofs, 40 to 48 degrees
    roof = Math.min(halfW * (0.85 + rand() * 0.25), 6)
  }
  if (b.roof === 'flat') roof = 0.2
  if (b.h && b.h > 2.5) {
    const k = b.h / (wall + roof)
    wall *= k
    roof *= k
  }
  return { wall, roof, kind }
}

// tightest bounding box that is aligned with one of the footprint's edges
function orientedBox(pts) {
  let best = null
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    let ux = b.x - a.x
    let uz = b.z - a.z
    const len = Math.hypot(ux, uz)
    if (len < 0.5) continue
    ux /= len
    uz /= len
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const p of pts) {
      const u = p.x * ux + p.z * uz
      const v = -p.x * uz + p.z * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (!best || area < best.area) best = { area, ux, uz, minU, maxU, minV, maxV }
  }
  return best
}

// keep the part of the polygon on one side of the ridge (side * d >= 0)
function clip(poly, side) {
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = side * a.d
    const db = side * b.d
    if (da >= 0) out.push(a)
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const t = da / (da - db)
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, d: 0, r: a.r + (b.r - a.r) * t })
    }
  }
  return out
}

// grow a counter-clockwise polygon outwards by `dist`
function grow(pts, dist) {
  const n = pts.length
  return pts.map((p, i) => {
    const a = pts[(i + n - 1) % n]
    const b = pts[(i + 1) % n]
    const l1 = Math.hypot(p.x - a.x, p.z - a.z) || 1
    const l2 = Math.hypot(b.x - p.x, b.z - p.z) || 1
    const n1x = (p.z - a.z) / l1
    const n1z = -(p.x - a.x) / l1
    const n2x = (b.z - p.z) / l2
    const n2z = -(b.x - p.x) / l2
    const k = dist / Math.max(0.35, 1 + n1x * n2x + n1z * n2z)
    return { x: p.x + (n1x + n2x) * k, z: p.z + (n1z + n2z) * k }
  })
}

const UP = [0, 1, 0]
const WHITE = new THREE.Color(0xffffff)

function addBuilding(b, index, hf, out, roadFrom) {
  const rand = rng(index * 7919 + 17)
  let pts = []
  for (let i = 0; i < b.p.length; i += 2) pts.push({ x: b.p[i], z: b.p[i + 1] })
  if (ringArea(b.p) < 0) pts.reverse() // everything below relies on one winding
  if (pts.length < 3) return null
  for (const p of pts) if (!hf.contains(p.x, p.z, 4)) return null

  const area = Math.abs(ringArea(b.p))
  const box = orientedBox(pts)
  if (!box || area < 4) return null

  // ridge runs along the long side of the box
  const lenU = box.maxU - box.minU
  const lenV = box.maxV - box.minV
  const alongU = lenU >= lenV
  const rx = alongU ? box.ux : -box.uz
  const rz = alongU ? box.uz : box.ux
  const nx = -rz
  const nz = rx
  const halfW = Math.min(lenU, lenV) / 2
  const mid = alongU ? (box.minV + box.maxV) / 2 : -(box.minU + box.maxU) / 2
  const measure = (p) => {
    p.d = p.x * nx + p.z * nz - mid // distance from the ridge
    p.r = p.x * rx + p.z * rz // position along the ridge
  }
  pts.forEach(measure)

  let gMin = Infinity
  let gMax = -Infinity
  let cx = 0
  let cz = 0
  for (const p of pts) {
    const h = hf.heightAt(p.x, p.z)
    if (h < gMin) gMin = h
    if (h > gMax) gMax = h
    cx += p.x / pts.length
    cz += p.z / pts.length
  }
  const floor = Math.min(gMax, gMin + 3.5)
  const base = gMin - 1.5
  const dim = dimensions(b, area, halfW, rand)
  const eave = floor + dim.wall
  const pitched = dim.roof > 0.3
  const roofAt = (d) => eave + dim.roof * (1 - Math.abs(d) / halfW) // also valid out on the overhang
  const wallTop = (d) => (pitched ? Math.max(eave - 0.25, roofAt(d)) : eave)

  // --- what kind of house is it
  const house = dim.kind === 'house'
  const old = house && Math.hypot(cx, cz) < 380 && area < 190
  let style = 'plain'
  if (house) style = old && rand() < 0.3 ? 'fachwerk' : rand() < 0.22 ? 'shutter' : 'window'
  const slateSide = house && style !== 'fachwerk' && rand() < 0.3
  const wallColor = new THREE.Color(dim.kind === 'church' ? 0xefe9da : dim.kind === 'house' ? WALLS[(rand() * WALLS.length) | 0] : rand() < 0.5 ? 0xd9d4c8 : 0xb7b0a2)
  const slateRoof = dim.kind === 'church' || rand() < 0.62
  const roofColor = new THREE.Color((slateRoof ? SLATE_ROOFS : TILE_ROOFS)[(rand() * 4) | 0]).multiplyScalar(0.9 + rand() * 0.25)
  const roofs = slateRoof ? out.slateRoof : out.tileRoof
  const slope = Math.hypot(halfW, dim.roof) / halfW
  const stone = new THREE.Color(0xd0d0d2)
  const plinthTop = floor + (dim.kind === 'shed' ? 0.15 : PLINTH)
  const segments = []

  const quad = (builder, p, q, y0, y1p, y1q, u0, u1, v, color, hint) => {
    const A = [p.x, y0, p.z]
    const B = [q.x, y0, q.z]
    const C = [q.x, y1q, q.z]
    const D = [p.x, y1p, p.z]
    builder.tri(A, B, C, [u0, v(y0)], [u1, v(y0)], [u1, v(y1q)], color, hint)
    builder.tri(A, C, D, [u0, v(y0)], [u1, v(y1q)], [u0, v(y1p)], color, hint)
  }

  const halves = pitched ? [clip(pts, 1), clip(pts, -1)] : [pts]
  for (const poly of halves) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      if (pitched && p.d === 0 && q.d === 0) continue // the cut along the ridge is no wall
      const len = Math.hypot(q.x - p.x, q.z - p.z)
      if (len < 0.05) continue
      const hint = [(q.z - p.z) / len, 0, -(q.x - p.x) / len]
      const cells = len < 1.8 ? 0 : Math.max(1, Math.round(len / TILE_W))
      const u0 = cells ? 0 : 0.03
      const u1 = cells || 0.03
      // slate on walls that face the weather
      const west = slateSide && hint[0] < -0.55
      const key = west ? 'slate' : style
      const tint = key === 'slate' || key === 'fachwerk' ? WHITE : wallColor
      quad(out.stone, p, q, base, plinthTop, plinthTop, 0, len / 1.6, (y) => (y - base) / 1.6, stone, hint)
      quad(out[key], p, q, plinthTop, wallTop(p.d), wallTop(q.d), u0, u1, (y) => (y - floor) / STOREY, tint, hint)
      if (cells) segments.push({ p, q, len, cells, hint })
    }
  }

  // --- roof, reaching out over the walls
  const roofPolys = pitched ? [0, 0] : [pts]
  if (pitched) {
    const outline = grow(pts, OVERHANG)
    outline.forEach(measure)
    roofPolys[0] = clip(outline, 1)
    roofPolys[1] = clip(outline, -1)
  }
  for (const poly of roofPolys) {
    if (poly.length < 3) continue
    const faces = THREE.ShapeUtils.triangulateShape(poly.map((p) => new THREE.Vector2(p.x, p.z)), [])
    const P = (p) => [p.x, pitched ? roofAt(p.d) + 0.06 : eave + 0.05, p.z]
    const T = (p) => [p.r / 1.2, (Math.abs(p.d) * slope) / 1.2]
    for (const f of faces) {
      const [a, c, e] = f.map((i) => poly[i])
      roofs.tri(P(a), P(c), P(e), T(a), T(c), T(e), roofColor, UP)
    }
  }

  // --- front door on the wall that looks at the street
  if (house || b.t === 'school' || b.t === 'kindergarten') {
    const road = roadFrom(cx, cz)
    let best = null
    for (const s of segments) {
      if (s.len < 3) continue
      const score = road ? s.hint[0] * road.x + s.hint[2] * road.z : s.len
      if (!best || score > best.score) best = { ...s, score }
    }
    if (best) {
      const t = (Math.floor(best.cells / 2) + 0.5) / best.cells
      const mx = best.p.x + (best.q.x - best.p.x) * t + best.hint[0] * 0.05
      const mz = best.p.z + (best.q.z - best.p.z) * t + best.hint[2] * 0.05
      const ex = ((best.q.x - best.p.x) / best.len) * 0.68
      const ez = ((best.q.z - best.p.z) / best.len) * 0.68
      const y0 = floor - 0.05
      const y1 = floor + 2.42
      const A = [mx - ex, y0, mz - ez]
      const B = [mx + ex, y0, mz + ez]
      const C = [mx + ex, y1, mz + ez]
      const D = [mx - ex, y1, mz - ez]
      const doorColor = new THREE.Color([0xf2f0ea, 0x7a5a3c, 0x4a5a4f, 0x8a3b30, 0x3f4a5a][(rand() * 5) | 0])
      out.door.tri(A, B, C, [0, 0], [1, 0], [1, 1], doorColor, best.hint)
      out.door.tri(A, C, D, [0, 0], [1, 1], [0, 1], doorColor, best.hint)
    }
  }

  // --- chimney next to the ridge
  if (house && pitched) {
    let lo = Infinity
    let hi = -Infinity
    for (const p of pts) {
      if (p.r < lo) lo = p.r
      if (p.r > hi) hi = p.r
    }
    const r0 = lo + (hi - lo) * (0.25 + rand() * 0.5)
    const d0 = (rand() < 0.5 ? -1 : 1) * Math.min(0.9, halfW * 0.25)
    const ccx = rx * r0 + nx * (d0 + mid)
    const ccz = rz * r0 + nz * (d0 + mid)
    const top = eave + dim.roof + 0.75
    const bottom = roofAt(d0) - 0.4
    const s = 0.28
    const brick = new THREE.Color(slateRoof ? 0x5d6066 : 0x8f4a38)
    const corner = (a, c) => ({ x: ccx + rx * a * s + nx * c * s, z: ccz + rz * a * s + nz * c * s })
    const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
    for (let i = 0; i < 4; i++) {
      const p = q[i]
      const n = q[(i + 1) % 4]
      const hint = [(p.x + n.x) / 2 - ccx, 0, (p.z + n.z) / 2 - ccz]
      quad(out.plain, p, n, bottom, top, top, 0.02, 0.04, () => 0.02, brick, hint)
    }
    out.plain.tri([q[0].x, top, q[0].z], [q[1].x, top, q[1].z], [q[2].x, top, q[2].z], [0, 0], [0, 0], [0, 0], brick, UP)
    out.plain.tri([q[0].x, top, q[0].z], [q[2].x, top, q[2].z], [q[3].x, top, q[3].z], [0, 0], [0, 0], [0, 0], brick, UP)
  }

  if (b.t === 'church' && area > 150) addTower(pts, rx, rz, mid, nx, nz, base, eave + dim.roof, wallColor, out)
  return { x: cx, z: cz }
}

// bell tower with a pointed slate spire at the western end of the nave
function addTower(pts, rx, rz, mid, nx, nz, base, ridgeY, wallColor, out) {
  let lo = Infinity
  let hi = -Infinity
  for (const p of pts) {
    if (p.r < lo) lo = p.r
    if (p.r > hi) hi = p.r
  }
  const west = rx < 0 ? hi : lo // whichever end points west
  const inward = rx < 0 ? -1 : 1
  const s = 3
  const r0 = west + inward * s
  const cx = rx * r0 + nx * mid
  const cz = rz * r0 + nz * mid
  const corner = (a, c) => ({ x: cx + rx * a * s + nx * c * s, z: cz + rz * a * s + nz * c * s })
  const q = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]
  const top = ridgeY + 7
  const tip = [cx, top + 11, cz]
  const spire = new THREE.Color(0x5a6068)
  for (let i = 0; i < 4; i++) {
    const p = q[i]
    const n = q[(i + 1) % 4]
    const hint = [(p.x + n.x) / 2 - cx, 0, (p.z + n.z) / 2 - cz]
    out.plain.tri([p.x, base, p.z], [n.x, base, n.z], [n.x, top, n.z], [0, 0], [0.05, 0], [0.05, 1], wallColor, hint)
    out.plain.tri([p.x, base, p.z], [n.x, top, n.z], [p.x, top, p.z], [0, 0], [0.05, 1], [0, 1], wallColor, hint)
    out.slateRoof.tri([p.x, top, p.z], [n.x, top, n.z], tip, [0, 9], [5, 9], [2.5, 0], spire, [hint[0], 0.3, hint[2]])
  }
}

// roadFrom(x, z) -> unit vector towards the nearest street, or null
export function buildBuildings(map, hf, roadFrom = () => null) {
  const keys = ['window', 'shutter', 'fachwerk', 'slate', 'plain', 'stone', 'door', 'slateRoof', 'tileRoof']
  const out = Object.fromEntries(keys.map((k) => [k, new GeoBuilder()]))
  const centres = []
  const footprints = []
  map.buildings.forEach((b, i) => {
    const c = addBuilding(b, i, hf, out, roadFrom)
    if (c) {
      centres.push(c)
      footprints.push(b.p)
    }
  })

  const group = new THREE.Group()
  group.name = 'buildings'
  const add = (key, tex, opts = {}) => {
    if (!out[key].pos.length) return
    const material = new THREE.MeshStandardMaterial({
      map: tex,
      normalMap: normalFrom(tex, opts.bump ?? 1.5),
      vertexColors: true,
      roughness: opts.roughness ?? 0.92,
      metalness: 0,
      side: opts.side ?? THREE.FrontSide,
    })
    const m = new THREE.Mesh(out[key].build(), material)
    m.castShadow = m.receiveShadow = true
    m.name = key
    group.add(m)
  }
  for (const key of ['window', 'shutter', 'fachwerk', 'slate', 'plain', 'stone', 'door']) add(key, wallTextures[key]())
  add('slateRoof', roofTextures.slate(), { roughness: 0.7, side: THREE.DoubleSide, bump: 2.5 })
  add('tileRoof', roofTextures.tile(), { roughness: 0.8, side: THREE.DoubleSide, bump: 3 })

  // coarse grid to answer "is there a house close by?"
  const CELL = 40
  const grid = new Map()
  const key = (x, z) => Math.floor(x / CELL) + ':' + Math.floor(z / CELL)
  centres.forEach((c, i) => {
    const k = key(c.x, c.z)
    if (!grid.has(k)) grid.set(k, [])
    grid.get(k).push(i)
  })
  const nearby = (x, z, fn) => {
    for (let dz = -CELL; dz <= CELL; dz += CELL)
      for (let dx = -CELL; dx <= CELL; dx += CELL) for (const i of grid.get(key(x + dx, z + dz)) ?? []) if (fn(i)) return true
    return false
  }

  return {
    group,
    count: centres.length,
    footprints,
    near: (x, z, dist = 38) => nearby(x, z, (i) => (centres[i].x - x) ** 2 + (centres[i].z - z) ** 2 < dist * dist),
    nearby,
    centres,
  }
}
