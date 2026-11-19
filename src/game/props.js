import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { buildCar, HATCH, VAN } from './carModel.js'
import { rng, inRing } from './util.js'

// The small things that make a street look lived in: street lamps, parked
// cars, wheelie bins, garden bushes and tall grass along the verges.

const CAR_COLORS = [0x8a8d91, 0x2d4a73, 0x3f5a48, 0x1f2226, 0xb9bdc2, 0x6d1f24, 0xc9c4b4, 0x4a5d6b]
const GRASS_CHUNK = 128 // metres; grass is only drawn in chunks near the camera
const GRASS_RANGE = 170

function tinted(geo, color) {
  const g = geo.index ? geo.toNonIndexed() : geo
  g.deleteAttribute('uv')
  const c = new THREE.Color(color)
  const col = new Float32Array(g.attributes.position.count * 3)
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i)
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

// a tuft of grass: a handful of blades, dark at the root and sunlit at the tip
function tuftGeometry() {
  const pos = []
  const col = []
  const r = rng(5)
  const root = new THREE.Color(0x4a6a2a)
  const tip = new THREE.Color(0xc4cf6e)
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2
    const d = r() * 0.55
    const x = Math.cos(a) * d
    const z = Math.sin(a) * d
    const h = 0.45 + r() * 0.55
    const w = 0.045
    const lean = 0.12 + r() * 0.2
    const ca = Math.cos(a + 1.3)
    const sa = Math.sin(a + 1.3)
    pos.push(x - ca * w, 0, z - sa * w, x + ca * w, 0, z + sa * w, x + Math.cos(a) * lean, h, z + Math.sin(a) * lean)
    col.push(root.r, root.g, root.b, root.r, root.g, root.b, tip.r, tip.g, tip.b)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  // all blades lit as if they faced up: no black backsides
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((v, i) => (i % 3 === 1 ? 1 : 0)), 3))
  return g
}

// roadFrom(x, z): direction from a point to the nearest street
export function buildProps({ runs, terrain, buildings, graph, obstacles, roadFrom }) {
  const rand = rng(4711)
  const group = new THREE.Group()
  group.name = 'props'
  const insideHouse = (x, z) => buildings.nearby(x, z, (i) => inRing(buildings.footprints[i], x, z))
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const instanced = (geo, mat, items, shadow = true) => {
    const mesh = new THREE.InstancedMesh(geo, mat, items.length)
    items.forEach((it, i) => {
      q.setFromAxisAngle(up, it.rot ?? 0)
      m4.compose(new THREE.Vector3(it.x, it.y ?? terrain.heightAt(it.x, it.z), it.z), q, new THREE.Vector3(it.sx ?? it.s ?? 1, it.sy ?? it.s ?? 1, it.sz ?? it.sx ?? it.s ?? 1))
      mesh.setMatrixAt(i, m4)
      if (it.color) mesh.setColorAt(i, it.color)
    })
    mesh.castShadow = shadow
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }

  // --- street lamps along the village streets, alternating sides
  const lamps = []
  const grass = new Map()
  let flip = 1
  for (const run of runs) {
    const { pts, style } = run
    const n = pts.length / 2
    const hw = style.w / 2
    for (let i = 1; i < n - 1; i++) {
      const x = pts[i * 2]
      const z = pts[i * 2 + 1]
      let tx = pts[i * 2 + 2] - pts[i * 2 - 2]
      let tz = pts[i * 2 + 3] - pts[i * 2 - 1]
      const tl = Math.hypot(tx, tz) || 1
      tx /= tl
      tz /= tl
      if (style.street && i % 13 === 6 && buildings.near(x, z)) {
        flip = -flip
        const lx = x - tz * flip * (hw + 1.5)
        const lz = z + tx * flip * (hw + 1.5)
        if (!insideHouse(lx, lz)) lamps.push({ x: lx, z: lz, rot: Math.atan2(-(x - lx), -(z - lz)), run, side: flip })
      }
      // tall grass on the verges, where there is neither road nor house
      if (!style.carve || style.tex === 'rail' || i % 2) continue
      for (const side of [-1, 1]) {
        for (let k = 0; k < 6; k++) {
          const d = hw + 4.6 + rand() * 10
          const gx = x - tz * side * d + (rand() - 0.5) * 3
          const gz = z + tx * side * d + (rand() - 0.5) * 3
          if (!terrain.contains(gx, gz, 4) || terrain.nearRoad(gx, gz) || insideHouse(gx, gz)) continue
          const key = Math.floor(gx / GRASS_CHUNK) + ':' + Math.floor(gz / GRASS_CHUNK)
          if (!grass.has(key)) grass.set(key, [])
          const v = 0.75 + rand() * 0.5
          grass.get(key).push({ x: gx, z: gz, rot: rand() * 6.28, sx: 0.8 + rand() * 0.8, sy: 0.45 + rand() * 0.7, color: new THREE.Color(v, v * (0.9 + rand() * 0.2), v * 0.8) })
        }
      }
    }
  }

  const steel = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.4 })
  const pole = mergeGeometries([
    tinted(new THREE.CylinderGeometry(0.06, 0.09, 6.4, 8).translate(0, 3.2, 0), 0x6f747a),
    tinted(new THREE.CylinderGeometry(0.04, 0.05, 1.7, 6).rotateX(Math.PI / 2 - 0.25).translate(0, 6.55, -0.8), 0x6f747a),
    tinted(new THREE.BoxGeometry(0.28, 0.1, 0.7).translate(0, 6.74, -1.75), 0x4a4e54),
  ])
  instanced(pole, steel, lamps)
  const glow = new THREE.MeshStandardMaterial({ color: 0xfff1cf, emissive: 0xffc97a, emissiveIntensity: 0.2, roughness: 0.4 })
  const heads = lamps.map((l) => ({ ...l }))
  instanced(new THREE.BoxGeometry(0.22, 0.05, 0.56).translate(0, 6.67, -1.75), glow, heads, false)
  for (const l of lamps) obstacles.push({ x: l.x, z: l.z, r: 0.14 })

  // overhead wires from mast to mast along each side of a street, sagging in the middle
  const wire = []
  const last = new Map()
  for (const l of lamps) {
    const key = l.run
    const prev = last.get(key)?.[l.side]
    if (prev && Math.hypot(prev.x - l.x, prev.z - l.z) < 110) {
      const y0 = terrain.heightAt(prev.x, prev.z) + 6.3
      const y1 = terrain.heightAt(l.x, l.z) + 6.3
      const mx = (prev.x + l.x) / 2
      const mz = (prev.z + l.z) / 2
      const my = (y0 + y1) / 2 - 0.7
      wire.push(prev.x, y0, prev.z, mx, my, mz, mx, my, mz, l.x, y1, l.z)
    }
    if (!last.has(key)) last.set(key, {})
    last.get(key)[l.side] = l
  }
  const wireGeo = new THREE.BufferGeometry()
  wireGeo.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3))
  group.add(new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: 0x14141a })))

  // --- cars parked at the kerb
  for (let i = 0; i < 16; i++) {
    const spot = graph.randomSpot(rand)
    const e = graph.edges[spot.edge]
    if (e.w < 5 || Math.hypot(spot.x, spot.z) < 40) continue // too narrow to get past, or where the taxi starts
    const side = rand() < 0.5 ? -1 : 1
    const p = graph.point(spot.edge, spot.t, side * (e.w / 2 - 0.95))
    const yaw = Math.atan2(p.dx, -p.dz) + (side < 0 ? Math.PI : 0)
    const spec = rand() < 0.8 ? HATCH : VAN
    const car = buildCar(spec, { color: CAR_COLORS[(rand() * CAR_COLORS.length) | 0], plate: `LM ${'ABDEHKMRST'[(rand() * 10) | 0]}${'ACEFLNPSTW'[(rand() * 10) | 0]} ${100 + ((rand() * 900) | 0)}` })
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)
    const hF = terrain.heightAt(p.x + sin * spec.axle, p.z - cos * spec.axle)
    const hR = terrain.heightAt(p.x - sin * spec.axle, p.z + cos * spec.axle)
    car.position.set(p.x, (hF + hR) / 2 + 0.16, p.z)
    car.rotation.set(Math.atan2(hF - hR, spec.axle * 2), -yaw, 0)
    group.add(car)
    for (let k = -1; k <= 1; k++) obstacles.push({ x: p.x + sin * k * 1.35, z: p.z - cos * k * 1.35, r: 0.9 })
  }

  // --- wheelie bins and bushes around the houses
  const bins = []
  const bushes = []
  const borders = [] // hedges and wooden fences between garden and street
  const hedgeGreen = new THREE.Color(0x3f6b2f)
  const fenceBrown = new THREE.Color(0x6b4a2e)
  const binColors = [0x3f6b3a, 0x4a4d52, 0x2f4f7a, 0x5a4630]
  buildings.footprints.forEach((fp, i) => {
    const c = buildings.centres[i]
    if (i % 3 === 0) {
      const dx = fp[0] - c.x
      const dz = fp[1] - c.z
      const d = Math.hypot(dx, dz) || 1
      const x = fp[0] + (dx / d) * 0.7
      const z = fp[1] + (dz / d) * 0.7
      if (!insideHouse(x, z) && !terrain.nearRoad(x, z)) bins.push({ x, z, rot: rand() * 6.28, color: new THREE.Color(binColors[(rand() * 4) | 0]) })
    }
    // garden border: walk from the house towards the street until the verge ends
    const dir = roadFrom(c.x, c.z)
    if (dir && i % 2 === 0) {
      let d = 5
      while (d < 30 && !terrain.nearRoad(c.x + dir.x * d, c.z + dir.z * d)) d += 1
      if (d > 8 && d < 30) {
        const hx = c.x + dir.x * (d - 1.3)
        const hz = c.z + dir.z * (d - 1.3)
        const wood = rand() < 0.4
        const tone = (wood ? fenceBrown : hedgeGreen).clone().multiplyScalar(0.8 + rand() * 0.4)
        // two stretches with a gap for the garden path
        for (const off of [-4.3, 4.3]) {
          const x = hx - dir.z * off
          const z = hz + dir.x * off
          if (insideHouse(x, z) || terrain.nearRoad(x, z)) continue
          borders.push({ x, z, rot: Math.atan2(-dir.x, -dir.z), sx: 6.2, sy: wood ? 1 : 1.2 + rand() * 0.4, sz: wood ? 0.08 : 0.85, color: tone })
        }
      }
    }
    for (let k = 0; k < 2; k++) {
      const a = rand() * 6.28
      const r = 7 + rand() * 6
      const x = c.x + Math.cos(a) * r
      const z = c.z + Math.sin(a) * r
      if (!terrain.contains(x, z, 4) || insideHouse(x, z) || terrain.nearRoad(x, z)) continue
      const v = 0.7 + rand() * 0.5
      bushes.push({ x, z, rot: rand() * 6.28, sx: 0.9 + rand() * 0.9, sy: 0.7 + rand() * 0.6, color: new THREE.Color(v * 0.9, v, v * 0.7) })
    }
  })
  const plain = new THREE.MeshStandardMaterial({ roughness: 0.8 })
  instanced(mergeGeometries([new THREE.BoxGeometry(0.55, 0.95, 0.65).translate(0, 0.52, 0), new THREE.BoxGeometry(0.6, 0.07, 0.72).translate(0, 1.03, 0)]), plain, bins)
  const leaf = new THREE.MeshLambertMaterial({ color: 0x55803a })
  const bush = new THREE.IcosahedronGeometry(1, 1)
  const bp = bush.attributes.position
  for (let i = 0; i < bp.count; i++) {
    const k = 1 + Math.sin(bp.getX(i) * 5.1 + bp.getZ(i) * 3.7) * 0.14
    bp.setXYZ(i, bp.getX(i) * k, Math.max(-0.2, bp.getY(i)) * 0.85 * k + 0.5, bp.getZ(i) * k)
  }
  bush.computeVertexNormals()
  instanced(bush, leaf, bushes)
  instanced(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), new THREE.MeshLambertMaterial(), borders)

  // --- grass, one instanced mesh per chunk
  // a little self-glow keeps backlit grass from turning black
  const blade = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x2a3312 })
  const tuft = tuftGeometry()
  const chunks = []
  let tufts = 0
  for (const [key, items] of grass) {
    const [cx, cz] = key.split(':').map(Number)
    const mesh = instanced(tuft, blade, items, false)
    mesh.visible = false
    chunks.push({ mesh, x: (cx + 0.5) * GRASS_CHUNK, z: (cz + 0.5) * GRASS_CHUNK })
    tufts += items.length
  }

  return {
    group,
    count: { lamps: lamps.length, tufts, bushes: bushes.length, bins: bins.length, borders: borders.length, wires: wire.length / 12 },
    // x, z: camera position; dark: 0 by day .. 1 at night
    update(x, z, dark) {
      for (const c of chunks) c.mesh.visible = Math.hypot(c.x - x, c.z - z) < GRASS_RANGE
      glow.emissiveIntensity = 0.2 + dark * 7
    },
  }
}
