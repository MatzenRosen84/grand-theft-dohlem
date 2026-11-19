import * as THREE from 'three'
import { toCreasedNormals, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { canvasTexture } from './textures.js'

// Cars are built from a side profile that is extruded across the car and then
// bent into shape: narrower towards nose and tail, leaning in above the belt
// line, with a slight crown on bonnet and roof.
// Local axes: -z forward, +x right, y = 0 on the road. Profiles are [s, y]
// with s along the car, positive towards the nose.

const curve = (pts, n) => new THREE.SplineCurve(pts.map(([s, y]) => new THREE.Vector2(s, y))).getPoints(n).map((p) => [p.x, p.y])

function arch(centre, radius, wheelR) {
  const pts = [[centre + radius, 0.2]]
  for (let i = 0; i <= 12; i++) {
    const a = (i / 12) * Math.PI
    pts.push([centre + Math.cos(a) * radius, wheelR + Math.sin(a) * radius])
  }
  pts.push([centre - radius, 0.2])
  return pts
}

// --- the three body styles ---------------------------------------------

// Opel Calibra: 4.49 m long, 1.69 m wide, 1.32 m high, wheelbase 2.60 m
export const CALIBRA = {
  width: 1.69,
  cabinWidth: 1.6,
  axle: 1.3,
  track: 1.48,
  wheelR: 0.31,
  nose: 2.245,
  bonnet: [[0.78, 0.825], [1.3, 0.775], [1.8, 0.7], [2.08, 0.615], [2.2, 0.54]],
  front: [[2.24, 0.46], [2.245, 0.32], [2.19, 0.2]],
  deck: [[-1.74, 0.875], [-2.1, 0.872], [-2.2, 0.85], [-2.24, 0.78]],
  rear: [[-2.245, 0.6], [-2.245, 0.34], [-2.2, 0.22]],
  screen: [[0.8, 0.8], [0.14, 1.275]],
  roof: [[0.14, 1.275], [-0.05, 1.305], [-0.4, 1.315], [-0.7, 1.3], [-0.85, 1.27]],
  back: [[-0.85, 1.27], [-1.3, 1.085], [-1.74, 0.87]],
  pillars: [-0.36],
  doors: [0.68, -0.42],
}

// compact hatchback, the usual village runabout
export const HATCH = {
  width: 1.7,
  cabinWidth: 1.62,
  axle: 1.24,
  track: 1.46,
  wheelR: 0.3,
  nose: 2.0,
  bonnet: [[0.95, 0.93], [1.4, 0.88], [1.75, 0.8], [1.93, 0.7]],
  front: [[1.99, 0.6], [2.0, 0.34], [1.95, 0.2]],
  deck: [[-1.86, 0.95], [-1.95, 0.93], [-1.99, 0.86]],
  rear: [[-2.0, 0.6], [-2.0, 0.36], [-1.95, 0.22]],
  screen: [[0.97, 0.91], [0.42, 1.38]],
  roof: [[0.42, 1.38], [0.1, 1.43], [-0.6, 1.44], [-1.2, 1.41], [-1.4, 1.36]],
  back: [[-1.4, 1.36], [-1.7, 1.15], [-1.86, 0.95]],
  pillars: [-0.18, -1.02],
  doors: [0.86, -0.22],
}

// small van / bus
export const VAN = {
  width: 1.84,
  cabinWidth: 1.78,
  axle: 1.45,
  track: 1.58,
  wheelR: 0.33,
  nose: 2.35,
  bonnet: [[1.55, 1.0], [1.9, 0.95], [2.2, 0.85], [2.3, 0.74]],
  front: [[2.34, 0.62], [2.35, 0.36], [2.3, 0.22]],
  deck: [[-2.28, 1.02], [-2.33, 0.98], [-2.35, 0.9]],
  rear: [[-2.35, 0.6], [-2.35, 0.36], [-2.3, 0.24]],
  screen: [[1.57, 0.98], [1.08, 1.78]],
  roof: [[1.08, 1.78], [0.7, 1.86], [-0.6, 1.88], [-1.9, 1.86], [-2.2, 1.8]],
  back: [[-2.2, 1.8], [-2.27, 1.4], [-2.28, 1.02]],
  pillars: [0.2, -1.0],
  doors: [1.35, 0.26],
}

// --- shaping ---------------------------------------------------------------

function makeBend(spec) {
  const belt = spec.screen[0][1]
  const half = spec.width / 2
  const top = Math.max(...spec.roof.map((p) => p[1]))
  return (v) => {
    const s = -v.z
    const end = Math.max(0, Math.abs(s) - spec.nose * 0.5) / (spec.nose * 0.5)
    const plan = 1 - 0.2 * end * end
    const tumble = v.y > belt ? 1 - (0.2 * (v.y - belt)) / (top - belt) : 1 - 0.035 * ((belt - v.y) / belt)
    const across = Math.min(1, Math.abs(v.x) / half)
    // crown on the upward faces
    if (v.y > belt - 0.25) v.y += (v.y > belt + 0.2 ? 0.03 : 0.022) * (1 - across * across)
    v.x *= plan * tumble
  }
}

function bendGeometry(geo, bend) {
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    bend(v)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

function extruded(profile, width, bevel, bend) {
  const shape = new THREE.Shape(profile.map(([s, y]) => new THREE.Vector2(s, y)))
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width - bevel * 2,
    steps: 10,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 4,
  })
  geo.translate(0, 0, -(width - bevel * 2) / 2)
  geo.rotateY(Math.PI / 2) // profile s -> -z, extrusion -> x
  return toCreasedNormals(bendGeometry(geo, bend), 0.75)
}

// strip lying on a stretch of the profile, from x0 to x1 across the car
function strip(path, x0, x1, bend, lift = 0.007, cols = 6) {
  const pos = []
  const idx = []
  const v = new THREE.Vector3()
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)]
    const b = path[Math.min(path.length - 1, i + 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    let ns = (b[1] - a[1]) / len
    let ny = -(b[0] - a[0]) / len
    if (ns * path[i][0] * 0.3 + ny < 0) {
      ns = -ns
      ny = -ny
    }
    for (let c = 0; c <= cols; c++) {
      v.set(x0 + ((x1 - x0) * c) / cols, path[i][1], -path[i][0])
      bend(v)
      pos.push(v.x, v.y + ny * lift, v.z - ns * lift)
      if (i > 0 && c > 0) {
        const k = i * (cols + 1) + c
        idx.push(k - cols - 2, k - cols - 1, k, k - cols - 2, k, k - 1)
      }
    }
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  return geo
}

// flat shape on one flank of the car, outline given as [s, y]
function flank(outline, side, halfWidth, bend, lift = 0.007) {
  const geo = new THREE.ShapeGeometry(new THREE.Shape(outline.map(([s, y]) => new THREE.Vector2(s, y))))
  const pos = geo.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.set(side * halfWidth, pos.getY(i), -pos.getX(i))
    bend(v)
    pos.setXYZ(i, v.x + side * lift, v.y, v.z)
  }
  geo.computeVertexNormals()
  return geo
}

const part = (path, from, to) => path.filter((p, i) => i / (path.length - 1) >= from - 1e-6 && i / (path.length - 1) <= to + 1e-6)

// --- small textures ----------------------------------------------------------

let rimTex
function rimTexture() {
  return (rimTex ??= canvasTexture(256, 256, (c, w) => {
    const m = w / 2
    c.fillStyle = '#17171a'
    c.fillRect(0, 0, w, w)
    c.translate(m, m)
    const lip = c.createRadialGradient(0, 0, m * 0.8, 0, 0, m)
    lip.addColorStop(0, '#8d9096')
    lip.addColorStop(0.5, '#f1f2f4')
    lip.addColorStop(1, '#a9acb1')
    c.fillStyle = lip
    c.beginPath()
    c.arc(0, 0, m, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#4a4c51'
    c.beginPath()
    c.arc(0, 0, m * 0.8, 0, Math.PI * 2)
    c.fill()
    // cross-laced spokes
    c.lineCap = 'round'
    for (const [color, width] of [['#8b8e93', 11], ['#eceef0', 7]]) {
      c.strokeStyle = color
      c.lineWidth = width
      for (let i = 0; i < 16; i++) {
        for (const lean of [-0.42, 0.42]) {
          const a = (i / 16) * Math.PI * 2
          c.beginPath()
          c.moveTo(Math.cos(a) * m * 0.2, Math.sin(a) * m * 0.2)
          c.lineTo(Math.cos(a + lean) * m * 0.81, Math.sin(a + lean) * m * 0.81)
          c.stroke()
        }
      }
    }
    c.fillStyle = '#c9ccd0'
    c.beginPath()
    c.arc(0, 0, m * 0.2, 0, Math.PI * 2)
    c.fill()
    c.fillStyle = '#9b1616'
    c.beginPath()
    c.arc(0, 0, m * 0.07, 0, Math.PI * 2)
    c.fill()
  }))
}

export function plateTexture(text) {
  const tex = canvasTexture(256, 56, (c, w, h) => {
    c.fillStyle = '#f4f4f0'
    c.fillRect(0, 0, w, h)
    c.strokeStyle = '#111'
    c.lineWidth = 3
    c.strokeRect(2, 2, w - 4, h - 4)
    c.fillStyle = '#1d3f9c'
    c.fillRect(4, 4, 22, h - 8)
    c.fillStyle = '#111'
    c.font = 'bold 38px "Arial Narrow", Arial, sans-serif'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(text, w / 2 + 12, h / 2 + 3)
  })
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

let shadowTex
function contactShadow(length, width) {
  shadowTex ??= canvasTexture(64, 64, (c, w) => {
    const g = c.createRadialGradient(w / 2, w / 2, w * 0.15, w / 2, w / 2, w / 2)
    g.addColorStop(0, 'rgba(0,0,0,0.75)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    c.fillStyle = g
    c.fillRect(0, 0, w, w)
  })
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 1.35, length * 1.2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8 }),
  )
  m.position.y = 0.03
  m.renderOrder = 20
  return m
}

// headlights of every car on or off; tail lights read `lit.on`
export const lit = { on: false }
export function carLights(on) {
  lit.on = on
  MATS.head.emissiveIntensity = on ? 7 : 0.35
}

// shared between all cars
const MATS = {
  glass: new THREE.MeshPhysicalMaterial({ color: 0x0a0d10, roughness: 0.04, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02, side: THREE.DoubleSide }),
  trim: new THREE.MeshStandardMaterial({ color: 0x3f4145, roughness: 0.65, side: THREE.DoubleSide }),
  black: new THREE.MeshStandardMaterial({ color: 0x0a0a0b, roughness: 0.85, side: THREE.DoubleSide }),
  rubber: new THREE.MeshStandardMaterial({ color: 0x131314, roughness: 0.92 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xd6d9dc, roughness: 0.18, metalness: 1 }),
  head: new THREE.MeshStandardMaterial({ color: 0xf2f4f5, roughness: 0.1, emissive: 0xfff3d6, emissiveIntensity: 0.35, side: THREE.DoubleSide }),
  amber: new THREE.MeshStandardMaterial({ color: 0xd9861c, roughness: 0.25, emissive: 0xff8a00, emissiveIntensity: 0.1, side: THREE.DoubleSide }),
}

export function buildCar(spec = CALIBRA, { color = 0xc4161c, stripes = null, plate = 'LM GT 93' } = {}) {
  const car = new THREE.Group()
  const body = new THREE.Group() // leans on the springs; wheels stay with `car`
  car.add(body)
  const bend = makeBend(spec)
  const half = spec.width / 2
  const cabHalf = spec.cabinWidth / 2
  const belt = spec.screen[0][1]

  const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.DoubleSide })
  const tail = new THREE.MeshStandardMaterial({ color: 0x4a0808, roughness: 0.2, emissive: 0xff1408, emissiveIntensity: 0.2, side: THREE.DoubleSide })
  // parts are collected and welded into one mesh per material at the end;
  // a car is then a handful of draw calls instead of forty
  const parts = new Map()
  const loose = [] // parts a crash can knock off; these stay separate meshes
  const add = (geo, mat, x = 0, y = 0, z = 0, shadow = false, detachable = false) => {
    if (mat.map || detachable) {
      // centre the geometry on itself so the part tumbles around its middle
      geo.computeBoundingBox()
      const c = geo.boundingBox.getCenter(new THREE.Vector3())
      geo.translate(-c.x, -c.y, -c.z)
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x + c.x, y + c.y, z + c.z)
      m.userData.loose = true
      body.add(m)
      loose.push(m)
      return
    }
    let g = geo.index ? geo.toNonIndexed() : geo
    g.translate(x, y, z)
    if (!g.attributes.normal) g.computeVertexNormals()
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name)
    const key = mat.uuid + shadow
    if (!parts.has(key)) parts.set(key, { mat, shadow, geos: [] })
    parts.get(key).geos.push(g)
  }

  const bonnet = curve(spec.bonnet, 14)
  const deck = curve(spec.deck, 8)
  const roof = curve(spec.roof, 12)
  const back = curve(spec.back, 8)
  const lower = [
    ...[...spec.rear].reverse(), ...[...deck].reverse(), [spec.back.at(-1)[0] + 1.1, belt + 0.03],
    ...bonnet, ...spec.front,
    ...arch(spec.axle, spec.wheelR + 0.05, spec.wheelR), ...arch(-spec.axle, spec.wheelR + 0.05, spec.wheelR),
  ]
  const cabin = [spec.screen[0], ...roof, ...back.slice(1), [back.at(-1)[0], belt - 0.12], [spec.screen[0][0], belt - 0.12]]
  add(extruded(lower, spec.width, 0.09, bend), paint, 0, 0, 0, true)
  add(extruded(cabin, spec.cabinWidth, 0.07, bend), paint, 0, 0, 0, true)
  add(new THREE.BoxGeometry(spec.width - 0.5, 0.3, spec.nose * 1.7), MATS.black, 0, 0.37, 0)

  // windscreen and rear screen, each on a black rubber surround
  const [s0, s1] = spec.screen
  const screenPath = [0.04, 0.16, 0.4, 0.65, 0.9, 0.97].map((t) => [s0[0] + (s1[0] - s0[0]) * t, s0[1] + (s1[1] - s0[1]) * t])
  add(strip(screenPath, -cabHalf + 0.07, cabHalf - 0.07, bend, 0.006), MATS.black)
  add(strip(screenPath.slice(1, 5), -cabHalf + 0.12, cabHalf - 0.12, bend, 0.011), MATS.glass)
  add(strip(part(back, 0.05, 0.95), -cabHalf + 0.08, cabHalf - 0.08, bend, 0.006), MATS.black)
  add(strip(part(back, 0.125, 0.875), -cabHalf + 0.13, cabHalf - 0.13, bend, 0.011), MATS.glass)

  // side glass: the cabin outline pulled in a little, pillars laid over it
  const glassLine = [...screenPath.slice(1, 5), ...roof.slice(1, -1), ...part(back, 0.125, 0.82)]
  const mid = glassLine.reduce((a, p) => a + p[0], 0) / glassLine.length
  const sideGlass = glassLine.map(([s, y]) => [s + Math.sign(mid - s) * 0.07, Math.max(belt + 0.05, y - 0.075)])
  const roofY = Math.max(...roof.map((p) => p[1]))
  for (const side of [-1, 1]) {
    add(flank(sideGlass, side, cabHalf, bend, 0.004), MATS.glass)
    for (const s of spec.pillars)
      add(flank([[s - 0.04, belt + 0.03], [s + 0.04, belt + 0.03], [s + 0.04, roofY], [s - 0.04, roofY]], side, cabHalf, bend, 0.008), paint)
    // door shut lines, handle, rubbing strip, sill, mirror
    for (const s of spec.doors)
      add(flank([[s - 0.006, 0.27], [s + 0.006, 0.27], [s + 0.006, belt - 0.01], [s - 0.006, belt - 0.01]], side, half, bend, 0.003), MATS.black)
    const handle = spec.doors[1] + 0.2
    add(flank([[handle, belt - 0.13], [handle + 0.16, belt - 0.13], [handle + 0.16, belt - 0.09], [handle, belt - 0.09]], side, half, bend, 0.006), MATS.black)
    const reach = spec.axle - spec.wheelR - 0.1
    add(flank([[-reach, 0.44], [reach, 0.44], [reach, 0.49], [-reach, 0.49]], side, half, bend, 0.012), MATS.trim)
    add(flank([[-reach, 0.2], [reach, 0.2], [reach, 0.27], [-reach, 0.27]], side, half, bend, 0.004), MATS.black)
    const mirror = new THREE.SphereGeometry(0.085, 10, 8).scale(1.1, 0.75, 0.8)
    add(mirror, paint, side * (cabHalf * 0.98 + 0.07), belt + 0.09, -(s0[0] - 0.22), true, true)
  }

  if (stripes !== null) {
    const white = new THREE.MeshStandardMaterial({ color: stripes, roughness: 0.35, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    for (const centre of [-0.21, 0.21])
      for (const path of [[...bonnet, spec.front[0]], roof, [...deck, spec.rear[0]]]) add(strip(path, centre - 0.105, centre + 0.105, bend, 0.004, 2), white)
  }

  // nose: slim headlights, indicators, grille slot, bumper strip
  const noseBand = part(bonnet, 0.86, 1)
  for (const side of [-1, 1]) {
    add(strip(noseBand, side * 0.3, side * (half - 0.11), bend, 0.008, 3), MATS.head)
    add(strip(noseBand, side * (half - 0.1), side * (half - 0.02), bend, 0.008, 1), MATS.amber)
  }
  add(strip(noseBand, -0.27, 0.27, bend, 0.008, 2), MATS.black)
  const f = spec.front
  add(strip([[f[0][0], 0.5], [f[1][0], 0.44]], -half, half, bend, 0.012, 8), MATS.trim, 0, 0, 0, false, true)
  add(strip([[f[1][0], 0.31], [f[1][0], 0.25]], -0.5, 0.5, bend, 0.01, 3), MATS.black)

  // tail: light band, bumper strip, plates, exhaust
  const r = spec.rear
  const tailX = r[0][0]
  for (const side of [-1, 1]) add(strip([[tailX, 0.63], [tailX + 0.004, 0.76]], side * 0.3, side * (half - 0.04), bend, 0.01, 3), tail)
  add(strip([[tailX, 0.5], [tailX, 0.44]], -half, half, bend, 0.012, 8), MATS.trim, 0, 0, 0, false, true)
  const plateMat = new THREE.MeshStandardMaterial({ map: plateTexture(plate), roughness: 0.5 })
  add(new THREE.BoxGeometry(0.5, 0.11, 0.012), plateMat, 0, 0.695, -tailX + 0.016)
  add(new THREE.BoxGeometry(0.5, 0.11, 0.012).rotateY(Math.PI), plateMat, 0, 0.37, -f[1][0] - 0.014)
  add(new THREE.CylinderGeometry(0.036, 0.036, 0.24, 12).rotateX(Math.PI / 2), MATS.chrome, -0.48, 0.2, -tailX - 0.06, false, true)

  // wheels: [pivot (steers) > spinner (rolls)]
  const R = spec.wheelR
  const tyreShape = [[R * 0.7, -0.105], [R * 0.93, -0.105], [R, -0.075], [R, 0.075], [R * 0.93, 0.105], [R * 0.7, 0.105]]
  const tyreGeo = new THREE.LatheGeometry(tyreShape.map(([a, b]) => new THREE.Vector2(a, b)), 28).rotateZ(Math.PI / 2)
  const rimGeo = new THREE.CylinderGeometry(R * 0.72, R * 0.72, 0.19, 28).rotateZ(Math.PI / 2)
  const rimFace = new THREE.MeshStandardMaterial({ map: rimTexture(), roughness: 0.28, metalness: 0.85 })
  const wheels = []
  for (const [x, z, front] of [[-1, -spec.axle, true], [1, -spec.axle, true], [-1, spec.axle, false], [1, spec.axle, false]]) {
    const pivot = new THREE.Group()
    pivot.position.set((x * spec.track) / 2, R, z)
    const spinner = new THREE.Group()
    const tyre = new THREE.Mesh(tyreGeo, MATS.rubber)
    tyre.castShadow = true
    spinner.add(tyre, new THREE.Mesh(rimGeo, [MATS.chrome, rimFace, rimFace]))
    pivot.add(spinner)
    car.add(pivot)
    wheels.push({ pivot, spinner, front })
  }

  for (const { mat, shadow, geos } of parts.values()) {
    const m = new THREE.Mesh(mergeGeometries(geos), mat)
    m.castShadow = shadow
    body.add(m)
  }

  car.add(contactShadow(spec.nose * 2, spec.width))
  car.rotation.order = 'YXZ'
  car.userData = { wheels, tail, body, spec, loose }
  return car
}
