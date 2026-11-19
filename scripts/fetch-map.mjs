// Downloads the map of the play area and writes it to public/data.
//
//   map.json     roads, buildings, land use, water, trees, points of interest
//   height.bin   terrain heights of the play area   (Uint16, decimetres above meta.minH)
//   outer.bin    coarse heights of the surroundings (same encoding)
//
// Sources: OpenStreetMap via the Overpass API (ODbL) and the Mapzen/AWS
// "terrarium" elevation tiles. Run with: npm run fetch-map

import { mkdir, writeFile } from 'node:fs/promises'
import { PNG } from 'pngjs'

const CENTER = { lat: 50.4855, lon: 8.0128 } // Thalheim, Dornburg
const SIZE = 3072 // edge length of the play area in metres
const GRID = 769 // height samples per edge -> 4 m cells
const OUTER_SIZE = 12288 // backdrop terrain
const OUTER_GRID = 129 // -> 96 m cells
const OUT_DIR = new URL('../public/data/', import.meta.url)

const R = 6378137
const RAD = Math.PI / 180
const cosLat0 = Math.cos(CENTER.lat * RAD)
const UA = { 'User-Agent': 'osm-village-viewer/0.1' }

// local metres: +x east, +z south
const toX = (lon) => (lon - CENTER.lon) * RAD * R * cosLat0
const toZ = (lat) => -(lat - CENTER.lat) * RAD * R
const toLon = (x) => CENTER.lon + x / (RAD * R * cosLat0)
const toLat = (z) => CENTER.lat - z / (RAD * R)
const r2 = (v) => Math.round(v * 100) / 100

// ---------------------------------------------------------------- OSM

async function overpass(query) {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ]
  let lastErr
  for (const url of endpoints) {
    try {
      console.log('  querying', new URL(url).host)
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.log('  failed:', err.message)
      lastErr = err
    }
  }
  throw lastErr
}

const flat = (geom) => {
  const out = []
  for (const g of geom) out.push(r2(toX(g.lon)), r2(toZ(g.lat)))
  return out
}

// drop the repeated closing point of a ring
const openRing = (p) => {
  const n = p.length
  if (n >= 4 && p[0] === p[n - 2] && p[1] === p[n - 1]) return p.slice(0, n - 2)
  return p
}

// join the member ways of a multipolygon into closed rings
function stitch(ways) {
  const parts = ways.map((w) => w.geometry.map((g) => [g.lon, g.lat]))
  const rings = []
  const key = (pt) => pt[0] + ',' + pt[1]
  while (parts.length) {
    let ring = parts.pop()
    let grew = true
    while (key(ring[0]) !== key(ring[ring.length - 1]) && grew) {
      grew = false
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        const end = key(ring[ring.length - 1])
        if (key(p[0]) === end) ring = ring.concat(p.slice(1))
        else if (key(p[p.length - 1]) === end) ring = ring.concat(p.reverse().slice(1))
        else continue
        parts.splice(i, 1)
        grew = true
        break
      }
    }
    if (ring.length >= 4) rings.push(ring.map(([lon, lat]) => ({ lon, lat })))
  }
  return rings
}

function areaKind(t) {
  if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin') return 'water'
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest'
  if (t.natural === 'scrub') return 'scrub'
  if (t.landuse === 'farmland') return 'farmland'
  if (t.landuse === 'meadow' || t.natural === 'grassland' || t.landuse === 'grass') return 'meadow'
  if (t.landuse === 'orchard' || t.landuse === 'vineyard' || t.landuse === 'allotments') return 'orchard'
  if (t.landuse === 'residential') return 'residential'
  if (t.landuse === 'farmyard') return 'farmyard'
  if (['industrial', 'commercial', 'retail', 'quarry', 'construction'].includes(t.landuse)) return 'industrial'
  if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery'
  if (['park', 'garden', 'playground', 'village_green', 'recreation_ground'].includes(t.leisure ?? t.landuse)) return 'park'
  if (t.leisure === 'pitch' || t.leisure === 'sports_centre') return 'pitch'
  if (t.amenity === 'parking') return 'parking'
  return null
}

function parseOsm(osm) {
  const roads = []
  const buildings = []
  const areas = []
  const waterways = []
  const trees = []
  const pois = []

  const addBuilding = (t, outer, holes = []) => {
    buildings.push({
      p: openRing(flat(outer)),
      holes: holes.length ? holes.map((h) => openRing(flat(h))) : undefined,
      t: t.building,
      lv: t['building:levels'] ? Number(t['building:levels']) : undefined,
      h: t.height ? parseFloat(t.height) : undefined,
      roof: t['roof:shape'],
      n: t.name,
      am: t.amenity ?? t.shop ?? t.tourism,
      addr: t['addr:street'] ? `${t['addr:street']} ${t['addr:housenumber'] ?? ''}`.trim() : undefined,
    })
  }

  for (const el of osm.elements) {
    const t = el.tags ?? {}

    if (el.type === 'node') {
      const x = r2(toX(el.lon))
      const z = r2(toZ(el.lat))
      if (t.natural === 'tree') trees.push(x, z)
      else if (t.name || t.highway === 'bus_stop') {
        const k = t.amenity ?? t.shop ?? t.tourism ?? t.place ?? t.highway ?? t.historic ?? t.leisure
        if (k) pois.push({ k, n: t.name, x, z })
      }
      continue
    }

    if (el.type === 'way') {
      if (!el.geometry || el.geometry.length < 2) continue
      if (t.highway) {
        if (['proposed', 'construction', 'platform', 'bus_stop', 'rest_area'].includes(t.highway)) continue
        if (t.area === 'yes') continue
        roads.push({
          k: t.highway,
          n: t.name,
          ref: t.ref,
          p: flat(el.geometry),
          lanes: t.lanes ? Number(t.lanes) : undefined,
          oneway: t.oneway === 'yes' || undefined,
          max: t.maxspeed ? parseInt(t.maxspeed) || undefined : undefined,
          surf: t.surface,
          grade: t.tracktype,
          bridge: t.bridge ? true : undefined,
          tunnel: t.tunnel ? true : undefined,
          svc: t.service,
        })
        continue
      }
      if (t.building) {
        if (el.geometry.length >= 4) addBuilding(t, el.geometry)
        continue
      }
      if (t.waterway) {
        if (['stream', 'river', 'ditch', 'canal', 'drain'].includes(t.waterway) && !t.tunnel)
          waterways.push({ k: t.waterway, n: t.name, p: flat(el.geometry) })
        continue
      }
      if (t.railway === 'rail' || t.railway === 'disused' || t.railway === 'abandoned') {
        roads.push({ k: 'rail', p: flat(el.geometry), n: t.name, bridge: t.bridge ? true : undefined })
        continue
      }
      if (t.natural === 'tree_row') {
        // one tree every ~9 m along the row
        const p = flat(el.geometry)
        for (let i = 0; i + 3 < p.length; i += 2) {
          const dx = p[i + 2] - p[i]
          const dz = p[i + 3] - p[i + 1]
          const n = Math.max(1, Math.round(Math.hypot(dx, dz) / 9))
          for (let j = 0; j < n; j++) trees.push(r2(p[i] + (dx * j) / n), r2(p[i + 1] + (dz * j) / n))
        }
        continue
      }
      const k = areaKind(t)
      if (k && el.geometry.length >= 4) {
        areas.push({ k, n: t.name, p: openRing(flat(el.geometry)), leaf: t.leaf_type })
        if (t.name && ['pitch', 'park', 'cemetery'].includes(k)) {
          const g = el.geometry
          pois.push({ k, n: t.name, x: r2(toX(g[0].lon)), z: r2(toZ(g[0].lat)) })
        }
      }
      continue
    }

    if (el.type === 'relation' && t.type === 'multipolygon') {
      const members = (el.members ?? []).filter((m) => m.type === 'way' && m.geometry)
      const outers = stitch(members.filter((m) => m.role !== 'inner'))
      const inners = stitch(members.filter((m) => m.role === 'inner'))
      if (t.building) {
        for (const o of outers) addBuilding(t, o, outers.length === 1 ? inners : [])
        continue
      }
      const k = areaKind(t)
      if (!k) continue
      for (const o of outers)
        areas.push({
          k,
          n: t.name,
          p: openRing(flat(o)),
          holes: inners.length ? inners.map((h) => openRing(flat(h))) : undefined,
          leaf: t.leaf_type,
        })
    }
  }
  return { roads, buildings, areas, waterways, trees, pois }
}

// ---------------------------------------------------------------- elevation

const TILE_Z = 14
const tiles = new Map()

async function loadTile(tx, ty, z) {
  const id = `${z}/${tx}/${ty}`
  if (!tiles.has(id)) {
    tiles.set(
      id,
      (async () => {
        const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${id}.png`, { headers: UA })
        if (!res.ok) throw new Error(`elevation tile ${id}: HTTP ${res.status}`)
        return PNG.sync.read(Buffer.from(await res.arrayBuffer()))
      })(),
    )
  }
  return tiles.get(id)
}

async function sampleGrid(size, grid, z) {
  const n = 2 ** z
  const px = (lon) => ((lon + 180) / 360) * n * 256
  const py = (lat) => {
    const s = Math.sin(lat * RAD)
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256
  }
  const half = size / 2

  // fetch every tile the grid touches up front
  const x0 = Math.floor(px(toLon(-half)) / 256)
  const x1 = Math.floor(px(toLon(half)) / 256)
  const y0 = Math.floor(py(toLat(-half)) / 256)
  const y1 = Math.floor(py(toLat(half)) / 256)
  const jobs = []
  for (let ty = y0 - 1; ty <= y1 + 1; ty++) for (let tx = x0 - 1; tx <= x1 + 1; tx++) jobs.push(loadTile(tx, ty, z))
  const loaded = await Promise.all(jobs)
  const cols = x1 - x0 + 3
  const tileAt = (tx, ty) => loaded[(ty - (y0 - 1)) * cols + (tx - (x0 - 1))]

  const texel = (gx, gy) => {
    const png = tileAt(Math.floor(gx / 256), Math.floor(gy / 256))
    const i = ((gy & 255) * 256 + (gx & 255)) * 4
    return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768
  }

  const h = new Float32Array(grid * grid)
  for (let j = 0; j < grid; j++) {
    const fy = py(toLat(-half + (size * j) / (grid - 1))) - 0.5
    for (let i = 0; i < grid; i++) {
      const fx = px(toLon(-half + (size * i) / (grid - 1))) - 0.5
      const ix = Math.floor(fx)
      const iy = Math.floor(fy)
      const u = fx - ix
      const v = fy - iy
      h[j * grid + i] =
        texel(ix, iy) * (1 - u) * (1 - v) +
        texel(ix + 1, iy) * u * (1 - v) +
        texel(ix, iy + 1) * (1 - u) * v +
        texel(ix + 1, iy + 1) * u * v
    }
  }
  return h
}

// separable box blur; takes the stair-steps out of the source data
function blur(h, grid, radius, passes) {
  const tmp = new Float32Array(h.length)
  const run = (src, dst, stride, other) => {
    for (let a = 0; a < grid; a++)
      for (let b = 0; b < grid; b++) {
        let sum = 0
        let cnt = 0
        for (let d = -radius; d <= radius; d++) {
          const bb = b + d
          if (bb < 0 || bb >= grid) continue
          sum += src[a * other + bb * stride]
          cnt++
        }
        dst[a * other + b * stride] = sum / cnt
      }
  }
  for (let p = 0; p < passes; p++) {
    run(h, tmp, 1, grid)
    run(tmp, h, grid, 1)
  }
  return h
}

function encode(h, minH) {
  const out = new Uint16Array(h.length)
  for (let i = 0; i < h.length; i++) out[i] = Math.max(0, Math.round((h[i] - minH) * 10))
  return Buffer.from(out.buffer)
}

// ---------------------------------------------------------------- main

const half = SIZE / 2
const pad = 60
const bbox = [toLat(half + pad), toLon(-half - pad), toLat(-half - pad), toLon(half + pad)].map((v) => v.toFixed(6)).join(',')

console.log('OpenStreetMap ...')
const osm = await overpass(`
[out:json][timeout:120][bbox:${bbox}];
(
  way[highway]; way[building]; way[landuse]; way[natural]; way[leisure];
  way[waterway]; way[railway]; way[amenity=parking]; way[amenity=grave_yard];
  relation[type=multipolygon][building];
  relation[type=multipolygon][landuse];
  relation[type=multipolygon][natural];
  node[natural=tree];
  node[amenity][name]; node[shop][name]; node[tourism][name]; node[place][name];
  node[historic][name]; node[highway=bus_stop];
);
out geom;`)
const map = parseOsm(osm)
console.log(
  `  ${map.roads.length} roads, ${map.buildings.length} buildings, ${map.areas.length} areas, ` +
    `${map.waterways.length} waterways, ${map.trees.length / 2} trees, ${map.pois.length} pois`,
)

console.log('Elevation ...')
const inner = blur(await sampleGrid(SIZE, GRID, TILE_Z), GRID, 3, 2)
const outer = blur(await sampleGrid(OUTER_SIZE, OUTER_GRID, 12), OUTER_GRID, 1, 1)
let minH = Infinity
let maxH = -Infinity
for (const arr of [inner, outer])
  for (const v of arr) {
    if (v < minH) minH = v
    if (v > maxH) maxH = v
  }
minH = Math.floor(minH)
console.log(`  ${minH} m to ${Math.ceil(maxH)} m above sea level`)

map.meta = {
  name: 'Thalheim',
  lat: CENTER.lat,
  lon: CENTER.lon,
  size: SIZE,
  grid: GRID,
  outerSize: OUTER_SIZE,
  outerGrid: OUTER_GRID,
  minH,
  maxH: Math.ceil(maxH),
  fetched: new Date().toISOString().slice(0, 10),
  attribution: '© OpenStreetMap contributors (ODbL); elevation: Mapzen terrain tiles',
}

await mkdir(OUT_DIR, { recursive: true })
await writeFile(new URL('map.json', OUT_DIR), JSON.stringify(map))
await writeFile(new URL('height.bin', OUT_DIR), encode(inner, minH))
await writeFile(new URL('outer.bin', OUT_DIR), encode(outer, minH))
console.log('Written to public/data')
