import * as THREE from 'three'
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { rng, inArea, inRing, ringBounds, ringArea } from './util.js'

const MAX_FOREST_TREES = 32000
const CHUNKS = 16 // per side; woods off screen are skipped, near ones get the detailed model
const NEAR = 150 // metres within which trees use the detailed model

// Colours a tree part by height: darker inside and underneath, lighter on top.
function shade(geo, low, high, y0, y1, seed) {
  const g = geo.index ? geo.toNonIndexed() : geo
  g.deleteAttribute('uv')
  const pos = g.attributes.position
  const col = new Float32Array(pos.count * 3)
  const a = new THREE.Color(low)
  const b = new THREE.Color(high)
  const c = new THREE.Color()
  const r = rng(seed)
  for (let i = 0; i < pos.count; i += 3) {
    const jitter = seed ? 0.9 + r() * 0.2 : 1 // seed 0: even colour, so corners can be welded
    for (let j = 0; j < 3; j++) {
      const t = THREE.MathUtils.clamp((pos.getY(i + j) - y0) / (y1 - y0), 0, 1)
      c.copy(a).lerp(b, t).multiplyScalar(jitter)
      col[(i + j) * 3] = c.r
      col[(i + j) * 3 + 1] = c.g
      col[(i + j) * 3 + 2] = c.b
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

// lumpy ball of leaves
function crown(radius, detail, seed) {
  const g = new THREE.IcosahedronGeometry(radius, detail)
  const pos = g.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const n = Math.sin(v.x * 2.1 + seed) * Math.cos(v.y * 1.7 + seed * 2) + Math.sin(v.z * 2.6 - seed)
    v.multiplyScalar(1 + n * 0.11)
    pos.setXYZ(i, v.x, v.y * 0.82, v.z)
  }
  return g
}

function smooth(geo) {
  // welding the corners gives rounded shading instead of facets
  geo.deleteAttribute('normal')
  const g = mergeVertices(geo, 1e-3)
  g.computeVertexNormals()
  return g
}

// about 14 m tall at scale 1
function broadleaf(detail) {
  const trunk = shade(new THREE.CylinderGeometry(0.22, 0.45, 5.4, detail ? 8 : 5).translate(0, 2.7, 0), 0x4a3a2b, 0x6a5540, 0, 5, detail ? 0 : 1)
  const blobs = [[4.2, 0, 8.6, 0], [3.1, 2.3, 6.8, 0.9], [3, -2, 7.1, -1.3], [2.7, 0.3, 11.2, 0.4]]
  if (detail) blobs.push([2.4, -0.6, 6.4, 2.2], [2.2, 1.4, 9.8, -1.6])
  const parts = blobs.map(([r, x, y, z], i) => shade(crown(r, detail ? 1 : 0, i * 3.1).translate(x, y, z), 0x2f5220, 0x6f9c3c, 4.5, 13, detail ? 0 : i + 2))
  const geo = mergeGeometries([trunk, ...parts])
  return detail ? smooth(geo) : (geo.computeVertexNormals(), geo)
}

// spruce, about 20 m tall at scale 1
function conifer(detail) {
  const trunk = shade(new THREE.CylinderGeometry(0.16, 0.38, 6, detail ? 7 : 5).translate(0, 3, 0), 0x3d2f24, 0x57432f, 0, 6, 1)
  const tiers = detail ? 7 : 4
  const parts = []
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1)
    const r = 3.7 * (1 - t * 0.78)
    const h = detail ? 4.4 : 6.5
    const y = 3 + t * (detail ? 13 : 12.5)
    parts.push(shade(new THREE.ConeGeometry(r, h, detail ? 10 : 7).rotateY(i * 0.7).translate(0, y + h / 2, 0), 0x1f3d22, 0x3f6f3c, y, y + h, i + 4))
  }
  const geo = mergeGeometries([trunk, ...parts])
  geo.computeVertexNormals()
  return geo
}

// smooth blobs a few hundred metres wide; decides where conifers stand together
const patch = (x, z) => Math.sin(x * 0.011 + 2) * Math.cos(z * 0.013) + Math.sin((x - z) * 0.006 + 1) * 0.7

export function buildTrees(map, hf, buildings) {
  const rand = rng(2024)
  const size = map.meta.size
  // per chunk and species: [x, y, z, scale, tint, ...]
  const chunks = { broadleaf: new Map(), conifer: new Map() }
  let count = 0

  // trunks the car can hit, in a grid of 16 m cells
  const CELL = 16
  const trunks = new Map()
  const cellKey = (x, z) => Math.floor(x / CELL) * 4096 + Math.floor(z / CELL)

  const plant = (species, x, z, scale) => {
    if (!hf.contains(x, z, 3)) return
    const cx = Math.floor(((x + size / 2) / size) * CHUNKS)
    const cz = Math.floor(((z + size / 2) / size) * CHUNKS)
    const k = cz * CHUNKS + cx
    const list = chunks[species]
    if (!list.has(k)) list.set(k, [])
    list.get(k).push(x, hf.heightAt(x, z) - 0.3, z, scale, rand())
    count++
    if (scale > 0.42) {
      const key = cellKey(x, z)
      if (!trunks.has(key)) trunks.set(key, [])
      trunks.get(key).push(x, z, 0.36 * scale)
    }
  }

  const insideHouse = (x, z) => buildings.nearby(x, z, (i) => inRing(buildings.footprints[i], x, z))

  // jittered grid over a polygon
  const scatter = (area, spacing, each) => {
    const b = ringBounds(area.p)
    for (let z = b.minZ; z <= b.maxZ; z += spacing) {
      for (let x = b.minX; x <= b.maxX; x += spacing) {
        const px = x + (rand() - 0.5) * spacing * 0.9
        const pz = z + (rand() - 0.5) * spacing * 0.9
        if (inArea(area, px, pz)) each(px, pz)
      }
    }
  }

  const byKind = (k) => map.areas.filter((a) => a.k === k)
  const forests = byKind('forest')
  let forestArea = 0
  for (const f of forests) forestArea += Math.abs(ringArea(f.p))
  const spacing = Math.max(8, Math.sqrt(forestArea / MAX_FOREST_TREES))

  for (const f of forests) {
    scatter(f, spacing, (x, z) => {
      if (hf.nearRoad(x, z)) return
      let needle = patch(x, z) + (rand() - 0.5) * 0.6 > 0.25
      if (f.leaf === 'needleleaved') needle = true
      if (f.leaf === 'broadleaved') needle = false
      plant(needle ? 'conifer' : 'broadleaf', x, z, 0.75 + rand() * 0.55)
    })
  }
  for (const a of byKind('scrub'))
    scatter(a, 7, (x, z) => {
      if (!hf.nearRoad(x, z)) plant('broadleaf', x, z, 0.25 + rand() * 0.3)
    })
  for (const a of byKind('orchard')) scatter(a, 9, (x, z) => plant('broadleaf', x, z, 0.3 + rand() * 0.1))
  // gardens
  for (const a of [...byKind('residential'), ...byKind('cemetery'), ...byKind('park')])
    scatter(a, 22, (x, z) => {
      if (hf.nearRoad(x, z) || insideHouse(x, z)) return
      plant(rand() < 0.2 ? 'conifer' : 'broadleaf', x, z, 0.35 + rand() * 0.35)
    })
  // mapped single trees and tree rows
  for (let i = 0; i < map.trees.length; i += 2) plant('broadleaf', map.trees[i], map.trees[i + 1], 0.6 + rand() * 0.4)

  const group = new THREE.Group()
  group.name = 'trees'
  const material = new THREE.MeshLambertMaterial({ vertexColors: true })
  const geos = {
    broadleaf: [broadleaf(false), broadleaf(true)],
    conifer: [conifer(false), conifer(true)],
  }
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const up = new THREE.Vector3(0, 1, 0)
  const tint = new THREE.Color()
  const meshes = []

  for (const species of Object.keys(chunks)) {
    for (const [k, data] of chunks[species]) {
      const n = data.length / 5
      const mesh = new THREE.InstancedMesh(geos[species][0], material, n)
      for (let i = 0; i < n; i++) {
        const s = data[i * 5 + 3]
        const t = data[i * 5 + 4]
        q.setFromAxisAngle(up, t * Math.PI * 2)
        m4.compose(
          new THREE.Vector3(data[i * 5], data[i * 5 + 1], data[i * 5 + 2]),
          q,
          new THREE.Vector3(s * (0.9 + t * 0.25), s, s * (0.9 + t * 0.25)),
        )
        mesh.setMatrixAt(i, m4)
        // some trees a bit yellower, some darker
        mesh.setColorAt(i, tint.setRGB(0.8 + t * 0.35, 0.85 + ((t * 7) % 1) * 0.25, 0.75 + ((t * 13) % 1) * 0.2))
      }
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.computeBoundingSphere()
      group.add(mesh)
      const chunk = size / CHUNKS
      meshes.push({ mesh, lod: geos[species], cx: ((k % CHUNKS) + 0.5) * chunk - size / 2, cz: (Math.floor(k / CHUNKS) + 0.5) * chunk - size / 2 })
    }
  }

  return {
    group,
    count,
    // swap in the detailed model around the camera
    update(x, z) {
      for (const m of meshes) {
        const geo = m.lod[Math.hypot(m.cx - x, m.cz - z) < NEAR ? 1 : 0]
        if (m.mesh.geometry !== geo) m.mesh.geometry = geo
      }
    },
    trunksNear(x, z, fn) {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const list = trunks.get(cellKey(x + dx * CELL, z + dz * CELL))
          if (!list) continue
          for (let i = 0; i < list.length; i += 3) if (Math.abs(list[i] - x) < 3 && Math.abs(list[i + 1] - z) < 3) fn(list[i], list[i + 1], list[i + 2])
        }
    },
  }
}
