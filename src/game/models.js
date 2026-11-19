import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { rng, inRing, ringArea } from './util.js'
import { plateTexture } from './carModel.js'

// Ready-made models from public/models: the Calibra, a football field set and
// a pack of street props. Each is optional; whatever fails to load is skipped.

const FILES = { calibra: 'opel_calibra_1990.glb', field: 'cityprops/football_field_free.glb', street: 'cityprops/street_props.glb' }
const CHUNK = 128 // props are grouped in tiles and only drawn near the camera
const RANGE = 190

// lite: leave out the Calibra (25 MB, over 800,000 triangles); the built-in car is used instead
// onBytes(file, loaded, total) is called while the files download
export async function loadModels(lite = false, onBytes = () => {}) {
  const loader = new GLTFLoader()
  const base = import.meta.env.BASE_URL + 'models/'
  const out = {}
  await Promise.all(
    Object.entries(FILES).map(async ([key, file]) => {
      if (lite && key === 'calibra') return
      try {
        out[key] = (await loader.loadAsync(base + file, (e) => onBytes(file, e.loaded, e.total))).scene
        out[key].updateMatrixWorld(true)
      } catch (err) {
        console.warn(`Modell ${file} nicht geladen:`, err)
      }
    }),
  )
  return out
}

// The player's car from the Calibra model, in the form the game expects:
// 4.49 m long, nose towards -z, wheels on y = 0, all parts directly inside
// `body` with their shape baked into the geometry (the crash damage bends it).
// FRONT_AT_PLUS_Z says which way the nose points in the file.
const FRONT_AT_PLUS_Z = true
const PLATE = 'DT:HC 03'
// one white stripe over bonnet, roof and boot, a little left of the middle (x in metres, left is negative)
const STRIPE = [-0.4, -0.16]

// The stripe is painted in the shader: on the paintwork, wherever the surface
// faces upwards and lies inside the band. It follows the body even when dented.
function paintStripe(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;\nvarying float vCarUp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCarPos = position;\nvCarUp = normal.y;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCarPos;\nvarying float vCarUp;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        float band = smoothstep( ${STRIPE[0].toFixed(3)}, ${(STRIPE[0] + 0.012).toFixed(3)}, vCarPos.x ) * ( 1.0 - smoothstep( ${(STRIPE[1] - 0.012).toFixed(3)}, ${STRIPE[1].toFixed(3)}, vCarPos.x ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.93, 0.93, 0.9 ), band * smoothstep( 0.3, 0.45, vCarUp ) * step( 0.45, vCarPos.y ) );`,
      )
  }
  material.needsUpdate = true
}

// number plates front and rear, set against the bodywork at plate height
function addPlates(body, text) {
  const mat = new THREE.MeshStandardMaterial({ map: plateTexture(text), roughness: 0.5 })
  let rear = -Infinity
  let front = Infinity
  for (const m of body.children) {
    if (!m.isMesh || m.userData.loose) continue
    const p = m.geometry.attributes.position
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(p.getX(i)) > 0.22) continue
      const y = p.getY(i)
      const z = p.getZ(i)
      if (y > 0.73 && y < 0.83 && z > rear) rear = z // the recess between the tail lights
      if (y > 0.28 && y < 0.42 && z < front) front = z
    }
  }
  const plate = (y, z, turn) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.11, 0.012).rotateY(turn).translate(0, y, z), mat)
    body.add(mesh)
  }
  if (isFinite(rear)) plate(0.78, rear + 0.012, 0)
  if (isFinite(front)) plate(0.35, front - 0.012, Math.PI)
}
export function makeCalibra(src) {
  const box = new THREE.Box3().setFromObject(src)
  const size = box.getSize(new THREE.Vector3())
  const centre = box.getCenter(new THREE.Vector3())
  const alongX = size.x > size.z
  const s = 4.49 / Math.max(size.x, size.z)
  const fix = new THREE.Matrix4()
    .makeRotationY((alongX ? Math.PI / 2 : 0) + (FRONT_AT_PLUS_Z ? Math.PI : 0))
    .multiply(new THREE.Matrix4().makeScale(s, s, s))
    .multiply(new THREE.Matrix4().makeTranslation(-centre.x, -box.min.y, -centre.z))

  const car = new THREE.Group()
  const body = new THREE.Group()
  car.add(body)
  const loose = []
  const m4 = new THREE.Matrix4()
  const dim = new THREE.Vector3()
  const mid = new THREE.Vector3()
  src.traverse((o) => {
    if (!o.isMesh) return
    const geo = o.geometry.clone().applyMatrix4(m4.multiplyMatrices(fix, o.matrixWorld))
    geo.computeBoundingBox()
    geo.boundingBox.getSize(dim)
    geo.boundingBox.getCenter(mid)
    // the model comes in blue; the taxi is red
    const c = o.material.color
    if (c && c.b > c.r * 1.4 && c.b > c.g * 1.2 && !o.material.userData.repainted) {
      c.set(0xc4161c)
      o.material.userData.repainted = true
      paintStripe(o.material)
    }
    const mesh = new THREE.Mesh(geo, o.material)
    mesh.castShadow = dim.z > 2.4 // the big body shells are enough for the shadow
    // small parts on the outside can be knocked off in a crash
    const small = Math.max(dim.x, dim.y, dim.z) < 0.8 && (Math.abs(mid.x) > 0.6 || Math.abs(mid.z) > 1.8)
    const endPiece = Math.abs(mid.z) > 1.75 && dim.y < 0.45 && dim.z < 0.9 // bumpers, lamps, grille
    if (small || endPiece) {
      geo.translate(-mid.x, -mid.y, -mid.z)
      mesh.position.copy(mid)
      mesh.userData.loose = true
      loose.push(mesh)
    }
    body.add(mesh)
  })
  car.rotation.order = 'YXZ'
  const wheels = groupWheels(body, loose, car)
  addPlates(body, PLATE)
  car.userData = { wheels, tail: new THREE.MeshStandardMaterial(), body, loose, spec: { axle: 1.3, wheelR: WHEEL_R } }
  return car
}

// In the file every wheel consists of a few small parts (tyre, rim, hub) at
// one corner of the car. This collects them per corner into a wheel that can
// spin and steer, and takes them off the list of parts a crash can knock off.
const WHEEL_R = 0.31
function groupWheels(body, loose, car) {
  const wheels = []
  const size = new THREE.Vector3()
  const span = (m) => m.geometry.boundingBox.getSize(size).length()
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const corner = loose.filter((m) => Math.sign(m.position.x) === sx && Math.sign(m.position.z) === sz && Math.abs(m.position.x) > 0.55 && m.position.y < 0.5)
    if (!corner.length) continue
    // the biggest part down there is the tyre; its middle is the axle
    const tyre = corner.reduce((a, b) => (span(a) > span(b) ? a : b))
    const centre = tyre.position.clone()
    const pivot = new THREE.Group()
    pivot.position.copy(centre)
    const spinner = new THREE.Group()
    for (const m of corner) {
      if (Math.hypot(m.position.y - centre.y, m.position.z - centre.z) > 0.2) continue
      loose.splice(loose.indexOf(m), 1)
      m.userData.loose = false
      m.castShadow = true
      m.position.sub(centre)
      spinner.add(m) // moves it out of the body
    }
    pivot.add(spinner)
    car.add(pivot)
    wheels.push({ pivot, spinner, front: sz < 0 })
  }
  return wheels
}

// one prop from the street pack, stood upright at the origin and scaled to `height` metres
function prop(street, name, height) {
  const node = street.getObjectByName(name)
  if (!node) return null
  const copy = node.clone()
  node.matrixWorld.decompose(copy.position, copy.quaternion, copy.scale)
  const holder = new THREE.Group()
  holder.add(copy)
  holder.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(holder)
  const c = box.getCenter(new THREE.Vector3())
  const s = height / (box.max.y - box.min.y || 1)
  copy.position.sub(new THREE.Vector3(c.x, box.min.y, c.z))
  const scaled = new THREE.Group()
  scaled.add(holder)
  scaled.scale.setScalar(s)
  scaled.traverse((o) => {
    if (o.isMesh) o.castShadow = o.receiveShadow = true
  })
  return scaled
}

export function placeModels({ models, map, terrain, graph, buildings, obstacles }) {
  const rand = rng(909)
  const group = new THREE.Group()
  group.name = 'models'
  const tiles = new Map()
  const put = (object, x, z, rot = 0, y = terrain.heightAt(x, z)) => {
    object.position.set(x, y, z)
    object.rotation.y = rot
    const key = Math.floor(x / CHUNK) + ':' + Math.floor(z / CHUNK)
    if (!tiles.has(key)) {
      const tile = new THREE.Group()
      tile.visible = false
      tile.userData = { x: (Math.floor(x / CHUNK) + 0.5) * CHUNK, z: (Math.floor(z / CHUNK) + 0.5) * CHUNK }
      tiles.set(key, tile)
      group.add(tile)
    }
    tiles.get(key).add(object)
  }
  const insideHouse = (x, z) => buildings.nearby(x, z, (i) => inRing(buildings.footprints[i], x, z))
  const count = {}
  // props light enough to be shoved by the car: kind -> rough radius in metres
  const LIGHT = { cone: 0.3, bin: 0.4, crate: 0.5, carton: 0.4, barrel: 0.45 }
  const movables = []

  if (models.street) {
    const make = (name, height) => prop(models.street, name, height)
    const kit = {
      bench: make('bench', 0.9), bin: make('trash_bin', 1.0), cone: make('cone', 0.7), barrier: make('barrier_1', 1.0),
      block: make('road_block', 0.8), crate: make('crate', 0.8), carton: make('carton_', 0.5), barrel: make('Oil_Tank', 0.95), bollard: make('Cylin4', 0.9),
    }
    const add = (key, x, z, rot) => {
      if (!kit[key] || !terrain.contains(x, z, 6) || insideHouse(x, z)) return false
      const object = kit[key].clone()
      put(object, x, z, rot)
      if (LIGHT[key]) movables.push({ o: object, r: LIGHT[key], vx: 0, vz: 0, spin: 0, tip: 0, tips: key !== 'crate' && key !== 'carton' })
      count[key] = (count[key] ?? 0) + 1
      return true
    }
    // at the kerb: `out` metres beyond the edge of the road, on either side
    const kerb = (out) => {
      const spot = graph.randomSpot(rand)
      const e = graph.edges[spot.edge]
      const side = rand() < 0.5 ? -1 : 1
      const p = graph.point(spot.edge, spot.t, side * (e.w / 2 + out))
      return { ...p, yaw: Math.atan2(p.dx, p.dz), side }
    }
    // benches with a litter bin beside them, facing the street
    for (let i = 0; i < 26; i++) {
      const k = kerb(2.3)
      if (add('bench', k.x, k.z, k.yaw + (k.side > 0 ? Math.PI / 2 : -Math.PI / 2))) add('bin', k.x + k.dx * 1.6, k.z + k.dz * 1.6, k.yaw)
    }
    for (let i = 0; i < 30; i++) {
      const k = kerb(1.6)
      add(rand() < 0.5 ? 'bin' : 'bollard', k.x, k.z, k.yaw)
    }
    // small road works at the edge of the carriageway: a barrier, a few cones
    for (let i = 0; i < 9; i++) {
      const k = kerb(-0.4)
      if (!add(rand() < 0.5 ? 'barrier' : 'block', k.x, k.z, k.yaw)) continue
      obstacles.push({ x: k.x, z: k.z, r: 0.7 })
      for (const d of [-3, 3, 5.5]) add('cone', k.x + k.dx * d - k.dz * k.side * 0.3, k.z + k.dz * d + k.dx * k.side * 0.3, rand() * 6)
    }
    // crates, cartons and barrels stacked beside some houses
    buildings.footprints.forEach((fp, i) => {
      if (i % 5) return
      const c = buildings.centres[i]
      const dx = fp[2] - c.x
      const dz = fp[3] - c.z
      const d = Math.hypot(dx, dz) || 1
      const x = fp[2] + (dx / d) * 0.9
      const z = fp[3] + (dz / d) * 0.9
      if (terrain.nearRoad(x, z)) return
      const what = ['crate', 'carton', 'barrel'][(rand() * 3) | 0]
      add(what, x, z, rand() * 6)
      if (rand() < 0.5) add(what, x + 0.9, z + 0.3, rand() * 6)
    })
  }

  // the football set goes onto every real pitch (bigger than 3000 m²)
  if (models.field) {
    const box = new THREE.Box3().setFromObject(models.field)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    for (const area of map.areas) {
      if (area.k !== 'pitch' || Math.abs(ringArea(area.p)) < 3000) continue
      const p = area.p
      // long side of the pitch gives the direction; extents give the size
      let best = 0
      let ax = 1
      let az = 0
      for (let i = 0; i < p.length; i += 2) {
        const j = (i + 2) % p.length
        const len = Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1])
        if (len > best) {
          best = len
          ax = (p[j] - p[i]) / len
          az = (p[j + 1] - p[i + 1]) / len
        }
      }
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity, top = -Infinity, low = Infinity
      for (let i = 0; i < p.length; i += 2) {
        const u = p[i] * ax + p[i + 1] * az
        const v = -p[i] * az + p[i + 1] * ax
        minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v)
        top = Math.max(top, terrain.heightAt(p[i], p[i + 1]))
        low = Math.min(low, terrain.heightAt(p[i], p[i + 1]))
      }
      const cu = (minU + maxU) / 2
      const cv = (minV + maxV) / 2
      const x = cu * ax - cv * az
      const z = cu * az + cv * ax
      if (!terrain.contains(x, z, 60)) continue
      const longModel = size.x >= size.z
      const s = Math.min((maxU - minU) / Math.max(size.x, size.z), (maxV - minV) / Math.min(size.x, size.z))
      const set = models.field.clone()
      set.position.set(-centre.x, -box.min.y, -centre.z)
      const holder = new THREE.Group()
      holder.add(set)
      holder.scale.setScalar(s)
      holder.traverse((o) => {
        if (o.isMesh) o.receiveShadow = true
      })
      // The ground slopes, the pitch does not: it sits level at the height of
      // its highest corner on an earth bank that reaches down past the lowest.
      const wrap = new THREE.Group()
      wrap.add(holder)
      const depth = top - low + 1.5
      const bank = new THREE.Mesh(
        new THREE.BoxGeometry(size.x * s + 1.2, depth, size.z * s + 1.2),
        new THREE.MeshLambertMaterial({ color: 0x5a6b3c }),
      )
      bank.position.y = -depth / 2 - 0.03
      bank.receiveShadow = true
      wrap.add(bank)
      put(wrap, x, z, Math.atan2(-az, ax) + (longModel ? 0 : Math.PI / 2), top + 0.08)
      count.fields = (count.fields ?? 0) + 1
    }
  }

  return {
    group,
    count,
    movables, // the props that can be knocked about
    update(x, z) {
      for (const tile of tiles.values()) tile.visible = Math.hypot(tile.userData.x - x, tile.userData.z - z) < RANGE
    },
    // light props get knocked away by the car, slide, tip over and come to rest
    step(dt, car) {
      const sin = Math.sin(car.yaw)
      const cos = Math.cos(car.yaw)
      for (const m of movables) {
        const p = m.o.position
        const dx = p.x - car.x
        const dz = p.z - car.z
        if (Math.abs(dx) < 4 && Math.abs(dz) < 4 && car.speed > 0.5) {
          const ahead = dx * sin - dz * cos
          const aside = dx * cos + dz * sin
          if (Math.abs(ahead) < 2.3 + m.r && Math.abs(aside) < 0.9 + m.r) {
            // off it goes: a bit faster than the car and out to the side it was hit on
            const out = Math.sign(aside || 1)
            m.vx = car.vx * 1.15 + cos * out * 1.6
            m.vz = car.vz * 1.15 + sin * out * 1.6
            m.spin = (Math.random() - 0.5) * 9
            car.vx *= 0.985 // costs the car next to nothing
            car.vz *= 0.985
          }
        }
        const v = Math.hypot(m.vx, m.vz)
        if (v < 0.05) continue
        const nx = p.x + m.vx * dt
        const nz = p.z + m.vz * dt
        if (insideHouse(nx, nz) || !terrain.contains(nx, nz, 8)) {
          m.vx *= -0.3 // bounces off the wall
          m.vz *= -0.3
        } else {
          p.x = nx
          p.z = nz
        }
        p.y = terrain.heightAt(p.x, p.z)
        const k = Math.exp(-dt * 2.2)
        m.vx *= k
        m.vz *= k
        m.spin *= k
        m.o.rotation.y += m.spin * dt
        if (m.tips) {
          m.tip = Math.min(1.45, m.tip + v * dt * 0.9)
          m.o.rotation.z = m.tip
        }
      }
    },
  }
}
