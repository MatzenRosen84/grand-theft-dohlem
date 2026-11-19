import * as THREE from 'three'
import { noiseCanvas, detailTexture } from './textures.js'
import { ringBounds, rng } from './util.js'

const AREA_ORDER = [
  'farmland', 'meadow', 'orchard', 'scrub', 'forest', 'residential', 'farmyard',
  'industrial', 'park', 'cemetery', 'pitch', 'parking', 'water',
]

const AREA_COLOR = {
  meadow: '#7fa04a',
  orchard: '#7c9c4c',
  scrub: '#5e7a3a',
  forest: '#3d5629',
  residential: '#84985a',
  farmyard: '#9a917a',
  industrial: '#9a968b',
  park: '#6f9f49',
  cemetery: '#6d8d55',
  pitch: '#5c9c44',
  parking: '#77777a',
  water: '#3f6d86',
}
const FIELD_COLORS = ['#b5a562', '#8fa34d', '#a08d5a', '#9cb155', '#c2b272', '#7d9a45']

function trace(ctx, p) {
  ctx.moveTo(p[0], p[1])
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
  ctx.closePath()
}

function tracePath(ctx, area) {
  ctx.beginPath()
  trace(ctx, area.p)
  if (area.holes) for (const h of area.holes) trace(ctx, h)
}

function traceLine(ctx, p) {
  ctx.beginPath()
  ctx.moveTo(p[0], p[1])
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1])
}

// The whole play area painted from above; this is the terrain's colour map.
export function paintGround(map, px = 4096) {
  const size = map.meta.size
  const cv = document.createElement('canvas')
  cv.width = cv.height = px
  const ctx = cv.getContext('2d')
  const s = px / size
  ctx.setTransform(s, 0, 0, s, px / 2, px / 2)

  ctx.fillStyle = '#82994d'
  ctx.fillRect(-size / 2, -size / 2, size, size)

  const byKind = {}
  for (const a of map.areas) (byKind[a.k] ??= []).push(a)
  const rand = rng(99)

  for (const kind of AREA_ORDER) {
    for (const a of byKind[kind] ?? []) {
      tracePath(ctx, a)
      if (kind !== 'farmland') {
        ctx.fillStyle = AREA_COLOR[kind]
        ctx.fill('evenodd')
        if (kind === 'pitch') {
          ctx.strokeStyle = 'rgba(255,255,255,0.8)'
          ctx.lineWidth = 0.5
          ctx.stroke()
        }
        continue
      }
      // fields: each its own crop colour, with furrows
      ctx.fillStyle = FIELD_COLORS[(rand() * FIELD_COLORS.length) | 0]
      ctx.fill('evenodd')
      const b = ringBounds(a.p)
      const cx = (b.minX + b.maxX) / 2
      const cz = (b.minZ + b.maxZ) / 2
      const r = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2
      ctx.save()
      ctx.clip('evenodd')
      ctx.translate(cx, cz)
      ctx.rotate(rand() * Math.PI)
      ctx.strokeStyle = 'rgba(60,50,20,0.13)'
      ctx.lineWidth = 1.1
      ctx.beginPath()
      for (let o = -r; o < r; o += 3) {
        ctx.moveTo(-r, o)
        ctx.lineTo(r, o)
      }
      ctx.stroke()
      ctx.restore()
    }
  }

  // verges under roads, paved yards around houses
  ctx.lineCap = ctx.lineJoin = 'round'
  for (const r of map.roads) {
    const minor = ['track', 'path', 'footway', 'bridleway', 'steps'].includes(r.k)
    ctx.strokeStyle = minor ? 'rgba(140,128,100,0.75)' : 'rgba(112,106,92,0.7)'
    ctx.lineWidth = minor ? 3 : 11
    traceLine(ctx, r.p)
    ctx.stroke()
  }
  ctx.fillStyle = '#8e8a82'
  ctx.strokeStyle = '#8e8a82'
  ctx.lineWidth = 3
  for (const b of map.buildings) {
    ctx.beginPath()
    trace(ctx, b.p)
    ctx.fill()
    ctx.stroke()
  }

  // break up the flat fills
  const noise = noiseCanvas(256, 5)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'overlay'
  ctx.fillStyle = ctx.createPattern(noise, 'repeat')
  ctx.globalAlpha = 0.45
  ctx.fillRect(0, 0, px, px)
  ctx.globalAlpha = 0.4
  ctx.scale(37, 37)
  ctx.fillRect(0, 0, px / 37, px / 37)

  return cv
}

// Dark, flat map for the radar in the HUD.
export function paintMinimap(map, px = 2048) {
  const size = map.meta.size
  const cv = document.createElement('canvas')
  cv.width = cv.height = px
  const ctx = cv.getContext('2d')
  const s = px / size
  ctx.setTransform(s, 0, 0, s, px / 2, px / 2)
  ctx.fillStyle = '#4b5a45'
  ctx.fillRect(-size / 2, -size / 2, size, size)

  const fills = { forest: '#3a4a36', scrub: '#42523c', residential: '#5a5d5c', industrial: '#5f6060', farmyard: '#5a5d5c', water: '#4f86b5', pitch: '#4f6b48', parking: '#666869' }
  for (const kind of AREA_ORDER) {
    if (!fills[kind]) continue
    ctx.fillStyle = fills[kind]
    for (const a of map.areas) {
      if (a.k !== kind) continue
      tracePath(ctx, a)
      ctx.fill('evenodd')
    }
  }
  ctx.fillStyle = '#7d8083'
  for (const b of map.buildings) {
    ctx.beginPath()
    trace(ctx, b.p)
    ctx.fill()
  }
  ctx.strokeStyle = '#4f86b5'
  ctx.lineWidth = 2.5
  for (const w of map.waterways) {
    traceLine(ctx, w.p)
    ctx.stroke()
  }

  ctx.lineCap = ctx.lineJoin = 'round'
  const tiers = [
    [['track', 'path', 'footway', 'bridleway', 'steps'], '#8f8d80', 2],
    [['rail'], '#2c2c2c', 2.5],
    [['service'], '#b9b9b9', 3.5],
    [['residential', 'living_street', 'unclassified'], '#e2e2e2', 6.5],
    [['tertiary', 'secondary', 'primary'], '#ffffff', 9],
  ]
  for (const [kinds, color, width] of tiers) {
    ctx.strokeStyle = color
    ctx.lineWidth = width
    for (const r of map.roads) {
      if (!kinds.includes(r.k)) continue
      traceLine(ctx, r.p)
      ctx.stroke()
    }
  }
  return cv
}

export function buildTerrain(hf, groundCanvas, renderer) {
  const g = hf.grid
  const pos = new Float32Array(g * g * 3)
  const uv = new Float32Array(g * g * 2)
  for (let iz = 0, k = 0; iz < g; iz++) {
    for (let ix = 0; ix < g; ix++, k++) {
      pos[k * 3] = ix * hf.cell - hf.half
      pos[k * 3 + 1] = hf.data[k]
      pos[k * 3 + 2] = iz * hf.cell - hf.half
      uv[k * 2] = ix / (g - 1)
      uv[k * 2 + 1] = 1 - iz / (g - 1)
    }
  }
  const base = new THREE.BufferGeometry()
  base.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  base.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  // normals from the height differences to the neighbours
  const nor = new Float32Array(g * g * 3)
  for (let iz = 0, k = 0; iz < g; iz++) {
    for (let ix = 0; ix < g; ix++, k++) {
      const l = hf.data[k - (ix > 0 ? 1 : 0)]
      const r = hf.data[k + (ix < g - 1 ? 1 : 0)]
      const u = hf.data[k - (iz > 0 ? g : 0)]
      const d = hf.data[k + (iz < g - 1 ? g : 0)]
      const nx = l - r
      const nz = u - d
      const ny = 2 * hf.cell
      const len = Math.hypot(nx, ny, nz)
      nor[k * 3] = nx / len
      nor[k * 3 + 1] = ny / len
      nor[k * 3 + 2] = nz / len
    }
  }
  base.setAttribute('normal', new THREE.BufferAttribute(nor, 3))

  // The ground is cut into tiles so that tiles behind the camera are skipped,
  // and distant tiles are drawn with a quarter of the triangles.
  // Triangles are split the same way as in Heightfield.heightAt.
  const TILE = 64
  const tiles = []
  const indexFor = (x0, z0, x1, z1, step) => {
    const out = []
    for (let iz = z0; iz < z1; iz += step) {
      for (let ix = x0; ix < x1; ix += step) {
        const a = iz * g + ix
        const b = a + g * step
        out.push(a, b, a + step, b, b + step, a + step)
      }
    }
    return new THREE.BufferAttribute(new Uint32Array(out), 1)
  }
  const tex = new THREE.CanvasTexture(groundCanvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy()

  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 })
  // fine grain on top of the painted map, so it holds up at street level
  const detail = detailTexture()
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: detail }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float fine = texture2D( detailMap, vMapUv * 900.0 ).r;
        float mid = texture2D( detailMap, vMapUv * 61.0 ).r;
        diffuseColor.rgb *= ( 0.62 + 0.75 * fine ) * ( 0.8 + 0.4 * mid );`,
      )
  }

  const mesh = new THREE.Group()
  mesh.name = 'terrain'
  for (let z0 = 0; z0 < g - 1; z0 += TILE) {
    for (let x0 = 0; x0 < g - 1; x0 += TILE) {
      const x1 = Math.min(x0 + TILE, g - 1)
      const z1 = Math.min(z0 + TILE, g - 1)
      const geo = new THREE.BufferGeometry()
      for (const name of ['position', 'uv', 'normal']) geo.setAttribute(name, base.attributes[name])
      const fine = indexFor(x0, z0, x1, z1, 1)
      const coarse = indexFor(x0, z0, x1, z1, 2)
      geo.setIndex(fine)
      // bounds of this tile only; the shared vertex list covers the whole map
      let lo = Infinity
      let hi = -Infinity
      for (let iz = z0; iz <= z1; iz++)
        for (let ix = x0; ix <= x1; ix++) {
          const h = hf.data[iz * g + ix]
          if (h < lo) lo = h
          if (h > hi) hi = h
        }
      const cx = ((x0 + x1) / 2) * hf.cell - hf.half
      const cz = ((z0 + z1) / 2) * hf.cell - hf.half
      const half = (TILE * hf.cell) / 2
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, (lo + hi) / 2, cz), Math.hypot(half, half, (hi - lo) / 2))
      const tile = new THREE.Mesh(geo, mat)
      tile.receiveShadow = true
      mesh.add(tile)
      tiles.push({ geo, fine, coarse, cx, cz })
    }
  }
  // full detail near the camera, coarse beyond
  mesh.userData.update = (x, z) => {
    for (const t of tiles) {
      const want = Math.hypot(t.cx - x, t.cz - z) < 520 ? t.fine : t.coarse
      if (t.geo.index !== want) t.geo.setIndex(want)
    }
  }

  // skirt hides the seam to the coarse backdrop
  const sk = []
  const edge = (ix, iz) => [ix * hf.cell - hf.half, hf.data[iz * g + ix], iz * hf.cell - hf.half]
  const strip = (pts) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      sk.push(a[0], a[1], a[2], b[0], b[1], b[2], b[0], b[1] - 40, b[2])
      sk.push(a[0], a[1], a[2], b[0], b[1] - 40, b[2], a[0], a[1] - 40, a[2])
    }
  }
  const range = [...Array(g).keys()]
  strip(range.map((i) => edge(i, 0)))
  strip(range.map((i) => edge(i, g - 1)))
  strip(range.map((i) => edge(0, i)))
  strip(range.map((i) => edge(g - 1, i)))
  const skGeo = new THREE.BufferGeometry()
  skGeo.setAttribute('position', new THREE.Float32BufferAttribute(sk, 3))
  const skirt = new THREE.Mesh(skGeo, new THREE.MeshBasicMaterial({ color: 0x55683a, side: THREE.DoubleSide }))
  mesh.add(skirt)
  return mesh
}

// Coarse hills around the play area, so the horizon is not a cliff edge.
export function buildBackdrop(outer, innerSize) {
  const g = outer.grid
  const pos = new Float32Array(g * g * 3)
  const col = new Float32Array(g * g * 3)
  const rand = rng(4)
  const field = new THREE.Color(0x7d9550)
  const wood = new THREE.Color(0x3f5a2c)
  const c = new THREE.Color()
  const innerHalf = innerSize / 2 - 1
  for (let iz = 0, k = 0; iz < g; iz++) {
    for (let ix = 0; ix < g; ix++, k++) {
      const x = ix * outer.cell - outer.half
      const z = iz * outer.cell - outer.half
      const inside = Math.abs(x) < innerHalf && Math.abs(z) < innerHalf
      pos[k * 3] = x
      pos[k * 3 + 1] = outer.data[k] - (inside ? 30 : 0)
      pos[k * 3 + 2] = z
      // woods on the heights, fields in the valleys, roughly like the real thing
      const patch = Math.sin(x * 0.0021 + 1.3) * Math.cos(z * 0.0017 - 0.4) + Math.sin((x + z) * 0.0009)
      const t = THREE.MathUtils.clamp(0.35 + patch * 0.5 + outer.data[k] * 0.004 + (rand() - 0.5) * 0.3, 0, 1)
      c.copy(field).lerp(wood, t)
      col[k * 3] = c.r
      col[k * 3 + 1] = c.g
      col[k * 3 + 2] = c.b
    }
  }
  const idx = new Uint32Array((g - 1) * (g - 1) * 6)
  for (let iz = 0, k = 0; iz < g - 1; iz++) {
    for (let ix = 0; ix < g - 1; ix++) {
      const a = iz * g + ix
      const b = a + g
      idx[k++] = a
      idx[k++] = b
      idx[k++] = a + 1
      idx[k++] = b
      idx[k++] = b + 1
      idx[k++] = a + 1
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }))
  mesh.name = 'backdrop'
  return mesh
}
