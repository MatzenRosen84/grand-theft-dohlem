import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { buildCar, HATCH, VAN, lit } from './carModel.js'
import { rng, clamp } from './util.js'

// Everything else that moves: villagers on foot, dogs, cats and other cars.

const SKIN = [0xf1c9a5, 0xe0ac86, 0xc98f67, 0x9c6b47, 0xf5d5b8]
const HAIR = [0x2a1d14, 0x5a3b22, 0x8a6a3c, 0xb9b4a8, 0x1a1a1a, 0x9a4a22]
const TOPS = [0x2f4f7a, 0x7a2f33, 0x3d6b4a, 0xd9d2c0, 0x444a52, 0xc98a2b, 0x5a4a78, 0x8aa3b5, 0xb04a5a, 0x2b2b2e]
const LEGS = [0x2c3445, 0x3b3b3f, 0x5b6470, 0x4a3f33, 0x1f2430, 0x6b6250]
const CAR_COLORS = [0xb9bdc2, 0x1f2226, 0x2d4a73, 0xe8e8e4, 0x6d1f24, 0x3f5a48, 0x8a8d91, 0x24477a, 0xc9b26a]

const mat = (color) => new THREE.MeshStandardMaterial({ color, roughness: 0.85 })

// The animated characters in public/models/persons. Each file holds one
// character with one animation: a walker, a dancer and the waving customer.
const PEOPLE = { walk: 'Walking.fbx', dance: 'Locking Hip Hop Dance.fbx', wave: 'Waving.fbx' }

// Resolves to { walk, dance, wave }, each { scene, clip, scale, lift }.
// onBytes(file, loaded, total) is called while the files download
export async function loadPeople(onBytes = () => {}) {
  const loader = new FBXLoader()
  const base = import.meta.env.BASE_URL + 'models/persons/'
  const out = {}
  await Promise.all(
    Object.entries(PEOPLE).map(async ([key, file]) => {
      const scene = await loader.loadAsync(base + encodeURIComponent(file), (e) => onBytes(file, e.loaded, e.total))
      const clip = scene.animations[0]
      // keep the figure on the spot: the game moves it, so the hips must not walk off on their own
      for (const track of clip?.tracks ?? []) {
        if (!/Hips\.position$/.test(track.name)) continue
        for (let i = 0; i < track.values.length; i += 3) {
          track.values[i] = track.values[0]
          track.values[i + 2] = track.values[2]
        }
      }
      let triangles = 0
      scene.traverse((o) => {
        if (!o.isMesh) return
        o.castShadow = true
        o.frustumCulled = false // the pose can reach outside the rest-pose bounds
        triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3
        for (const m of [].concat(o.material)) m.shininess = 4
      })
      // whatever unit the file uses, the figure ends up 1.78 m tall with its feet on the ground
      const box = new THREE.Box3().setFromObject(scene)
      const scale = 1.78 / (box.max.y - box.min.y || 1)
      out[key] = { scene, clip, scale, lift: -box.min.y * scale, triangles: Math.round(triangles) }
    }),
  )
  return out
}

// one material for everybody; the colours are painted onto the geometry
const CLOTH = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide })

function painted(geo, color, x = 0, y = 0, z = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo
  g.deleteAttribute('uv')
  g.translate(x, y, z)
  const c = new THREE.Color(color)
  const col = new Float32Array(g.attributes.position.count * 3)
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i)
  g.setAttribute('color', new THREE.BufferAttribute(col, 3))
  return g
}

// A person about 1.78 m tall, facing -z: tapered torso, neck, head with a
// face, arms with elbows and hands, legs with knees and shoes.
// look: { hoodie, bottle }. Each rigid piece is one mesh, nine in all.
function buildPerson(rand, look = {}) {
  const g = new THREE.Group()
  const pick = (list) => list[(rand() * list.length) | 0]
  const skin = pick(SKIN)
  const top = pick(TOPS)
  const trousers = pick(LEGS)
  const hair = pick(HAIR)
  const dark = new THREE.Color(top).multiplyScalar(0.72)
  const shoes = rand() < 0.5 ? 0xe9e6df : 0x26262b
  const hoodUp = look.hoodie && rand() < 0.55

  const piece = (parts, parent = g, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(mergeGeometries(parts), CLOTH)
    m.castShadow = true
    const pivot = new THREE.Group()
    pivot.position.set(x, y, z)
    pivot.add(m)
    parent.add(pivot)
    return pivot
  }
  const ball = (r, sx = 1, sy = 1, sz = 1) => new THREE.SphereGeometry(r, 12, 9).scale(sx, sy, sz)

  // --- trunk and head, one piece
  const profile = [[0.125, 0.9], [0.165, 0.97], [0.15, 1.12], [0.172, 1.3], [0.19, 1.41], [0.13, 1.49], [0.06, 1.53]]
  const body = [
    painted(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 14).scale(1, 1, 0.64), top),
    painted(new THREE.CylinderGeometry(0.05, 0.055, 0.09, 10), skin, 0, 1.55, 0),
    painted(ball(0.105, 0.92, 1.13, 1), skin, 0, 1.67, 0),
    painted(ball(0.014), 0x1c1512, -0.036, 1.69, -0.093), // eyes
    painted(ball(0.014), 0x1c1512, 0.036, 1.69, -0.093),
    painted(ball(0.017, 1, 1.2, 1), new THREE.Color(skin).multiplyScalar(0.9), 0, 1.662, -0.103), // nose
    painted(new THREE.BoxGeometry(0.044, 0.007, 0.012), 0x7a3b36, 0, 1.622, -0.094), // mouth
    painted(ball(0.02, 0.6, 1.2, 1), skin, -0.098, 1.67, 0), // ears
    painted(ball(0.02, 0.6, 1.2, 1), skin, 0.098, 1.67, 0),
  ]
  if (rand() < 0.35) body.push(painted(new THREE.SphereGeometry(0.1, 12, 6, 0, Math.PI * 2, Math.PI * 0.58, Math.PI * 0.42).scale(0.94, 1.1, 1.02), hair, 0, 1.665, -0.004)) // beard
  if (look.hoodie) {
    body.push(painted(new THREE.CylinderGeometry(0.17, 0.168, 0.07, 14).scale(1, 1, 0.66), dark, 0, 0.92, 0)) // ribbed hem
    body.push(painted(new THREE.BoxGeometry(0.23, 0.1, 0.03), dark, 0, 1.06, -0.1)) // belly pocket
    body.push(painted(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 5), 0xf0ede6, -0.03, 1.4, -0.116)) // drawstrings
    body.push(painted(new THREE.CylinderGeometry(0.006, 0.006, 0.12, 5), 0xf0ede6, 0.03, 1.4, -0.116))
    if (hoodUp) {
      // hood over the head, open at the face
      body.push(painted(new THREE.SphereGeometry(0.135, 14, 10, Math.PI * 1.5 + 0.62, Math.PI * 2 - 1.24).scale(1, 1.13, 1.1), top, 0, 1.675, 0.012))
    } else {
      body.push(painted(ball(0.1, 1.3, 0.5, 0.95), top, 0, 1.5, 0.085)) // hood lying on the back
    }
  }
  if (!hoodUp) body.push(painted(new THREE.SphereGeometry(0.111, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.52).scale(0.94, 1.1, 1.03).rotateX(0.25), hair, 0, 1.68, 0.006))
  piece(body)

  // --- arms: shoulder > upper arm, elbow > forearm with hand
  const arm = (side) => {
    const shoulder = piece([painted(new THREE.CapsuleGeometry(0.05, 0.2, 3, 8), top, 0, -0.14, 0)], g, side * 0.218, 1.43, 0)
    const lower = [
      painted(new THREE.CapsuleGeometry(0.043, 0.17, 3, 8), top, 0, -0.12, 0),
      painted(ball(0.045, 0.85, 1.1, 1), skin, 0, -0.27, 0),
    ]
    if (side > 0 && look.bottle) {
      // beer bottle, held by the neck
      const glass = rand() < 0.5 ? 0x2f6b3a : 0x6b4a1f
      lower.push(painted(new THREE.CylinderGeometry(0.033, 0.033, 0.15, 8), glass, 0, -0.43, -0.03))
      lower.push(painted(new THREE.CylinderGeometry(0.013, 0.03, 0.09, 8), glass, 0, -0.31, -0.03))
    }
    const elbow = piece(lower, shoulder, 0, -0.29, 0)
    shoulder.rotation.z = side * 0.07
    return [shoulder, elbow]
  }
  // --- legs: hip > thigh, knee > shin with shoe
  const leg = (side) => {
    const hip = piece([painted(new THREE.CapsuleGeometry(0.068, 0.27, 3, 8), trousers, 0, -0.2, 0)], g, side * 0.085, 0.92, 0)
    const knee = piece(
      [
        painted(new THREE.CapsuleGeometry(0.052, 0.28, 3, 8), trousers, 0, -0.19, 0),
        painted(new THREE.BoxGeometry(0.095, 0.07, 0.25), shoes, 0, -0.415, -0.05),
      ],
      hip,
      0,
      -0.42,
      0,
    )
    return [hip, knee]
  }
  const [armL, elbowL] = arm(-1)
  const [armR, elbowR] = arm(1)
  const [legL, kneeL] = leg(-1)
  const [legR, kneeR] = leg(1)

  g.scale.setScalar(0.94 + rand() * 0.12)
  g.userData = { armL, armR, elbowL, elbowR, legL, legR, kneeL, kneeR }
  return g
}

function buildAnimal(kind, rand) {
  const g = new THREE.Group()
  const dog = kind === 'dog'
  const coats = dog ? [0x6b4a2e, 0xd9c7a3, 0x2a2623, 0xb5803c, 0xf0ece4] : [0x2b2b2b, 0xd98b3a, 0xe9e6df, 0x8a8a8a, 0x5c4630]
  const coat = mat(coats[(rand() * coats.length) | 0])
  const s = dog ? 0.75 + rand() * 0.5 : 0.5
  const mesh = (geo, x, y, z, parent = g) => {
    const o = new THREE.Mesh(geo, coat)
    o.position.set(x, y, z)
    o.castShadow = true
    parent.add(o)
    return o
  }
  // nose points to -z, like the cars
  mesh(new THREE.CapsuleGeometry(0.13, 0.42, 3, 8).rotateX(Math.PI / 2), 0, 0.42, 0)
  mesh(new THREE.SphereGeometry(0.11, 10, 8).scale(0.9, 0.9, 1.2), 0, 0.56, -0.36)
  mesh(new THREE.ConeGeometry(0.04, 0.09, 4), -0.06, 0.67, -0.33)
  mesh(new THREE.ConeGeometry(0.04, 0.09, 4), 0.06, 0.67, -0.33)
  const tail = new THREE.Group()
  tail.position.set(0, 0.5, 0.32)
  mesh(new THREE.CapsuleGeometry(0.025, dog ? 0.22 : 0.34, 2, 6).rotateX(-0.9), 0, 0.1, 0.1, tail)
  g.add(tail)
  const legs = []
  for (const [x, z] of [[-0.08, -0.22], [0.08, -0.22], [-0.08, 0.22], [0.08, 0.22]]) {
    const pivot = new THREE.Group()
    pivot.position.set(x, 0.34, z)
    mesh(new THREE.CapsuleGeometry(0.035, 0.24, 2, 6), 0, -0.16, 0, pivot)
    g.add(pivot)
    legs.push(pivot)
  }
  g.scale.setScalar(s)
  g.userData = { legs, tail }
  return g
}

const turnTo = (from, to, max) => {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from))
  return from + clamp(d, -max, max)
}

// Someone or something on foot. Yaw as for the cars: 0 = north, positive = east.
class Walker {
  // role: 'walker' | 'dancer' | 'customer'. With `models` (from loadPeople) people
  // are the animated characters; without, the simple built-in figures.
  constructor(kind, rand, look = { hoodie: rand() < 0.6, bottle: rand() < 0.4 }, models = null, role = 'walker') {
    this.kind = kind // 'person' | 'dog' | 'cat'
    this.rand = rand
    this.role = role
    const src = kind === 'person' && models?.[role === 'dancer' ? 'dance' : role === 'customer' ? 'wave' : 'walk']
    if (src?.clip) {
      const figure = cloneSkinned(src.scene)
      figure.scale.setScalar(src.scale * (0.95 + rand() * 0.1))
      figure.position.y = src.lift
      figure.rotation.y = Math.PI // the files face +z, the game's forward is -z
      this.mesh = new THREE.Group()
      this.mesh.add(figure)
      this.mixer = new THREE.AnimationMixer(figure)
      this.actions = { main: this.mixer.clipAction(src.clip) }
      this.actions.main.play()
      this.actions.main.time = rand() * src.clip.duration
    } else {
      this.mesh = kind === 'person' ? buildPerson(rand, look) : buildAnimal(kind, rand)
    }
    this.tipsy = kind === 'person' && look.bottle && !this.mixer // sways while walking
    this.x = 0
    this.z = 0
    this.yaw = 0
    this.pace = kind === 'person' ? 1.1 + rand() * 0.5 : kind === 'dog' ? 1.8 + rand() : 1.2 + rand()
    this.speed = 0
    this.phase = rand() * 6
    this.state = 'walk' // walk | wait | flee | down | idle
    this.timer = 0
    this.goal = null
    this.scripted = false // true while the taxi game moves this person
    this.wave = false
    this.fall = 0
  }

  // head for a point at the given speed; true once there
  walkTo(dt, gx, gz, speed) {
    const dx = gx - this.x
    const dz = gz - this.z
    const d = Math.hypot(dx, dz)
    if (d < 0.25) {
      this.speed = 0
      return true
    }
    this.yaw = turnTo(this.yaw, Math.atan2(dx, -dz), dt * 7)
    this.speed = speed
    const step = Math.min(d, speed * dt)
    this.x += (dx / d) * step
    this.z += (dz / d) * step
    return false
  }

  // animated character: pick the right clip and keep the feet in step with the ground
  animateModel(dt, terrain) {
    const a = this.actions
    if (this.role === 'customer' && a.walk) {
      const walking = this.speed > 0.2
      if (walking !== this.walking) {
        this.walking = walking
        const [on, off] = walking ? [a.walk, a.main] : [a.main, a.walk]
        on.reset().fadeIn(0.25).play()
        off.fadeOut(0.25)
      }
    } else if (this.role === 'walker') {
      a.main.timeScale = this.speed / 1.35 // stands still while waiting
    }
    this.mixer.update(dt)
    const target = this.state === 'down' ? 1 : 0
    this.fall += (target - this.fall) * (1 - Math.exp(-dt * 9))
    this.mesh.position.set(this.x, terrain.heightAt(this.x, this.z) + (this.lift ?? 0.08) + this.fall * 0.15, this.z)
    this.mesh.rotation.set(-this.fall * 1.45, -this.yaw, 0, 'YXZ')
  }

  animate(dt, terrain) {
    if (this.mixer) return this.animateModel(dt, terrain)
    this.phase += this.speed * dt * (this.kind === 'person' ? 3.4 : 7)
    const swing = Math.sin(this.phase) * Math.min(1, this.speed / 1.2)
    const u = this.mesh.userData
    if (this.kind === 'person') {
      // stride from the hips, the knee bends while that leg comes forward, arms swing against the legs
      const amp = Math.min(1, this.speed / 1.2)
      const bend = (shift) => Math.max(0, Math.sin(this.phase + shift)) * 0.95 * amp
      u.legL.rotation.x = swing * 0.55
      u.legR.rotation.x = -swing * 0.55
      u.kneeL.rotation.x = -bend(-2.2)
      u.kneeR.rotation.x = -bend(-2.2 + Math.PI)
      u.armL.rotation.x = -swing * 0.45
      u.elbowL.rotation.x = 0.25 + Math.max(0, -swing) * 0.45
      if (this.wave) {
        u.armR.rotation.x = Math.PI - 0.5 + Math.sin(performance.now() * 0.009) * 0.3
        u.armR.rotation.z = 0.25
        u.elbowR.rotation.x = 0.2
      } else {
        u.armR.rotation.x = swing * 0.45
        u.armR.rotation.z = 0.07
        u.elbowR.rotation.x = 0.25 + Math.max(0, swing) * 0.45
      }
    } else {
      u.legs.forEach((l, i) => (l.rotation.x = (i === 0 || i === 3 ? swing : -swing) * 0.7))
      u.tail.rotation.y = Math.sin(performance.now() * 0.012 + this.phase) * 0.5
    }
    // knocked over: tip onto the back, then get up again
    const target = this.state === 'down' ? 1 : 0
    this.fall += (target - this.fall) * (1 - Math.exp(-dt * 9))
    this.mesh.position.set(this.x, terrain.heightAt(this.x, this.z) + (this.lift ?? 0.08) + this.fall * 0.12, this.z)
    const sway = this.tipsy ? Math.sin(this.phase * 0.5) * 0.11 : 0
    this.mesh.rotation.set(-this.fall * 1.45, -this.yaw + sway * 0.6, sway, 'YXZ')
  }
}

// A car that follows the road network on its own.
class TrafficCar {
  constructor(graph, rand) {
    this.graph = graph
    this.rand = rand
    const spec = rand() < 0.75 ? HATCH : VAN
    this.mesh = buildCar(spec, { color: CAR_COLORS[(rand() * CAR_COLORS.length) | 0], plate: `LM ${'ABCDEFHKLMPRSTW'[(rand() * 15) | 0]}${'ABCDEFHKLMPRSTW'[(rand() * 15) | 0]} ${100 + ((rand() * 900) | 0)}` })
    this.spec = spec
    this.x = 0
    this.z = 0
    this.yaw = 0
    this.speed = 0
    this.stun = 0
    this.spin = 0
    // three circles along the body, for the player's car to bump into
    this.circles = [0, 1, 2].map(() => ({ x: 0, z: 0, r: 0.9, hit: (v) => this.onHit(v) }))
    this.struck = 0 // hardest hit since last read
  }

  onHit(v) {
    if (v > 1) {
      this.stun = 5
      this.speed *= 0.3
      this.struck = Math.max(this.struck, v)
    }
  }

  // put the car on an edge, heading from node `from` to the other end
  spawn(edgeIdx, from) {
    const e = this.graph.edges[edgeIdx]
    this.edge = edgeIdx
    this.from = from
    this.s = this.rand() * e.len * 0.5
    this.pickNext()
    const p = this.lanePoint(this.edge, this.from, this.s)
    this.x = p.x
    this.z = p.z
    this.yaw = Math.atan2(p.dx, -p.dz)
    this.speed = e.v * 0.6
    this.stun = 0
  }

  lanePoint(edgeIdx, from, s) {
    const e = this.graph.edges[edgeIdx]
    const flip = e.a !== from
    const lane = Math.min(e.w / 4, 1.55) // keep to the right
    const p = this.graph.point(edgeIdx, flip ? 1 - s / e.len : s / e.len, flip ? -lane : lane)
    if (flip) {
      p.dx = -p.dx
      p.dz = -p.dz
    }
    return p
  }

  pickNext() {
    const g = this.graph
    const e = g.edges[this.edge]
    const end = g.other(e, this.from)
    const options = g.nodes[end].edges.filter((i) => i !== this.edge && g.edges[i].main && !g.edges[i].minor)
    if (options.length) {
      this.nextEdge = options[(this.rand() * options.length) | 0]
      this.nextFrom = end
    } else {
      // dead end: come back the same way
      this.nextEdge = this.edge
      this.nextFrom = end
    }
  }

  update(dt, terrain, blockers) {
    const g = this.graph
    let e = g.edges[this.edge]
    if (this.stun > 0) this.stun -= dt

    // aim at a point a little way down the lane
    const look = 3.5 + this.speed * 0.5
    let aim
    if (this.s + look <= e.len) aim = this.lanePoint(this.edge, this.from, this.s + look)
    else aim = this.lanePoint(this.nextEdge, this.nextFrom, Math.min(this.s + look - e.len, g.edges[this.nextEdge].len))

    // slow for bends, stop for anything in the way
    const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(aim.dx, -aim.dz) - this.yaw), Math.cos(Math.atan2(aim.dx, -aim.dz) - this.yaw)))
    let want = Math.min(e.v, g.edges[this.nextEdge].v + (e.len - this.s) * 0.4) * 0.85
    want = Math.min(want, 14 - turn * 14, 16)
    want = Math.max(want, 2.5)
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const reach = 4.5 + this.speed * 1.7
    for (const b of blockers) {
      if (b.owner === this) continue
      const dx = b.x - this.x
      const dz = b.z - this.z
      const ahead = dx * sin - dz * cos
      const aside = dx * cos + dz * sin
      if (ahead > 0.5 && ahead < reach + b.r && Math.abs(aside) < 1.25 + b.r) want = Math.min(want, ahead < 5 + b.r ? 0 : 3)
    }
    if (this.stun > 0) want = 0
    this.speed += clamp(want - this.speed, -7 * dt, 2.2 * dt)
    if (this.speed < 0.05 && want === 0) this.speed = 0

    this.yaw = turnTo(this.yaw, Math.atan2(aim.x - this.x, -(aim.z - this.z)), ((this.speed + 0.3) / 4.5) * dt)
    this.x += Math.sin(this.yaw) * this.speed * dt
    this.z -= Math.cos(this.yaw) * this.speed * dt
    this.s += this.speed * dt
    if (this.s >= e.len) {
      this.s -= e.len
      this.edge = this.nextEdge
      this.from = this.nextFrom
      this.pickNext()
    }

    // sit on the road
    const a = this.spec.axle
    const hF = terrain.heightAt(this.x + sin * a, this.z - cos * a)
    const hR = terrain.heightAt(this.x - sin * a, this.z + cos * a)
    this.mesh.position.set(this.x, (hF + hR) / 2 + 0.16, this.z)
    this.mesh.rotation.set(Math.atan2(hF - hR, a * 2), -this.yaw, 0)
    this.spin += (this.speed * dt) / this.spec.wheelR
    for (const w of this.mesh.userData.wheels) w.spinner.rotation.x = -this.spin
    this.mesh.userData.tail.emissiveIntensity = want < this.speed - 0.5 ? 6 : lit.on ? 1.6 : 0.2
    this.circles.forEach((c, i) => {
      c.x = this.x + sin * (i - 1) * 1.35
      c.z = this.z - cos * (i - 1) * 1.35
    })
  }
}

export class Population {
  // models: the animated characters from loadPeople(), or null for the simple figures
  constructor(scene, graph, terrain, counts = { cars: 7, people: 12, dogs: 0, cats: 0 }, models = null) {
    this.models = models
    this.scene = scene
    this.graph = graph
    this.terrain = terrain
    this.rand = rng(77)
    this.cars = []
    this.walkers = []
    this.obstacles = [] // circles the player's car collides with
    this.blockers = [] // things traffic brakes for
    this.events = [] // { type: 'person' | 'dog' | 'cat' | 'car', speed }
    for (let i = 0; i < counts.cars; i++) this.cars.push(new TrafficCar(graph, this.rand))
    for (const [kind, n] of [['person', counts.people], ['dog', counts.dogs], ['cat', counts.cats]])
      for (let i = 0; i < n; i++) this.walkers.push(new Walker(kind, this.rand, undefined, models, i % 3 === 2 ? 'dancer' : 'walker')) // every third one dances
    for (const c of this.cars) {
      scene.add(c.mesh)
      this.obstacles.push(...c.circles)
    }
    for (const w of this.walkers) scene.add(w.mesh)
    this.placed = false
  }

  // an extra person the taxi game controls (customers)
  createPerson() {
    const w = new Walker('person', this.rand, { hoodie: true, bottle: true }, this.models, 'customer')
    w.scripted = true
    w.state = 'idle'
    this.walkers.push(w)
    this.scene.add(w.mesh)
    return w
  }

  release(w) {
    w.scripted = false
    w.wave = false
    w.state = 'walk'
    w.goal = null
    w.lost = true // respawn it somewhere else once out of sight
    // carry on along whichever street they were dropped at
    const near = this.graph.nearest(w.x, w.z)
    const e = this.graph.edges[near.edge]
    Object.assign(w, { edge: near.edge, from: e.a, s: near.t * e.len, side: 1, margin: 1.1 })
  }

  // a dropped-off passenger: stays where they stand, with the animation they have
  park(w) {
    w.scripted = false
    w.parked = true
    w.state = 'idle'
    w.speed = 0
  }

  // take someone out of the world for good
  remove(w) {
    w.gone = true
    this.scene.remove(w.mesh)
  }

  // a street edge between `min` and `max` metres from the player
  edgeNear(px, pz, min, max) {
    const g = this.graph
    for (let tries = 0; tries < 60; tries++) {
      const i = g.streets[(this.rand() * g.streets.length) | 0]
      const a = g.nodes[g.edges[i].a]
      const d = Math.hypot(a.x - px, a.z - pz)
      if (d >= min && d <= max) return i
    }
    return g.streets[(this.rand() * g.streets.length) | 0]
  }

  placeWalker(w, px, pz, min, max) {
    const g = this.graph
    w.edge = this.edgeNear(px, pz, min, max)
    const e = g.edges[w.edge]
    w.from = this.rand() < 0.5 ? e.a : e.b
    w.s = this.rand() * e.len
    w.side = this.rand() < 0.5 ? -1 : 1
    // animals keep further from the road, in the gardens
    // people keep to the pavement; animals go where they like
    w.margin = w.role === 'dancer' ? 1.6 + this.rand() * 2.5 : w.kind === 'person' ? 1.1 : this.rand() * 4 - 1.8
    if (w.role === 'dancer') w.yaw = this.rand() * Math.PI * 2
    const p = this.pathPoint(w)
    w.x = p.x
    w.z = p.z
    w.goal = null
    w.state = 'walk'
    w.lost = false
  }

  pathPoint(w) {
    const e = this.graph.edges[w.edge]
    const flip = e.a !== w.from
    const off = w.side * (e.w / 2 + w.margin)
    return this.graph.point(w.edge, flip ? 1 - w.s / e.len : w.s / e.len, flip ? -off : off)
  }

  // view: the point the camera looks at; things far from it are not drawn
  update(dt, player, view = player) {
    if (this.walkers.some((w) => w.gone)) this.walkers = this.walkers.filter((w) => !w.gone)
    const g = this.graph
    const px = player.x
    const pz = player.z
    if (!this.placed) {
      this.placed = true
      for (const c of this.cars) {
        const i = this.edgeNear(px, pz, 60, 500)
        c.spawn(i, g.edges[i].a)
      }
      for (const w of this.walkers) if (!w.scripted) this.placeWalker(w, px, pz, 20, 420)
    }

    const sinP = Math.sin(player.yaw)
    const cosP = Math.cos(player.yaw)
    const pSpeed = player.speed

    // what traffic has to brake for
    const blockers = this.blockers
    blockers.length = 0
    for (let i = -1; i <= 1; i++) blockers.push({ x: px + sinP * i * 1.4, z: pz - cosP * i * 1.4, r: 0.9, owner: player })
    for (const c of this.cars) for (const k of c.circles) blockers.push({ x: k.x, z: k.z, r: k.r, owner: c })
    for (const w of this.walkers) if (w.state !== 'idle' || w.scripted) blockers.push({ x: w.x, z: w.z, r: 0.35, owner: w })

    for (const c of this.cars) {
      if (Math.hypot(c.x - px, c.z - pz) > 700) {
        const i = this.edgeNear(px, pz, 250, 520)
        c.spawn(i, this.rand() < 0.5 ? g.edges[i].a : g.edges[i].b)
      }
      c.update(dt, this.terrain, blockers)
      c.mesh.visible = Math.abs(c.x - view.x) + Math.abs(c.z - view.z) < 420
      if (c.struck) {
        this.events.push({ type: 'car', speed: c.struck })
        c.struck = 0
      }
    }

    for (const w of this.walkers) {
      const dx = w.x - px
      const dz = w.z - pz
      const dist = Math.hypot(dx, dz)
      // position relative to the player's car
      const ahead = dx * sinP - dz * cosP
      const aside = dx * cosP + dz * sinP

      // sliding away from a bump
      if (w.sore > 0) w.sore -= dt
      if (w.pushX || w.pushZ) {
        w.x += w.pushX * dt
        w.z += w.pushZ * dt
        const k = Math.exp(-dt * 6)
        w.pushX *= k
        w.pushZ *= k
        if (Math.hypot(w.pushX, w.pushZ) < 0.1) w.pushX = w.pushZ = 0
      }

      // run over?
      if (w.state !== 'down' && Math.abs(ahead) < 2.45 && Math.abs(aside) < 1.05) {
        if (pSpeed > 2.2) {
          // bumped out of the way, to the side they were hit on; they stay on their feet
          const out = Math.sign(aside || 1)
          w.pushX = cosP * out * 6 + player.vx * 0.25
          w.pushZ = sinP * out * 6 + player.vz * 0.25
          if (!(w.sore > 0)) this.events.push({ type: w.kind, speed: pSpeed, scripted: w.scripted })
          w.sore = 1.5 // one fine per bump, not one per frame
        } else if (!w.scripted) {
          // nudged at walking pace: step out of the way
          w.x += cosP * Math.sign(aside || 1) * dt * 2
          w.z += sinP * Math.sign(aside || 1) * dt * 2
        }
      }

      if (w.state === 'down') {
        w.speed = 0
        w.timer -= dt
        if (w.timer <= 0) w.state = w.scripted ? 'idle' : 'flee'
        if (w.state === 'flee') w.timer = 2
      } else if ((w.role === 'dancer' || w.parked) && !w.scripted) {
        // dancers stay where they are and keep dancing; so do dropped-off passengers, until out of sight
        w.speed = 0
        if (w.parked && dist > 220) this.remove(w)
        else if (dist > 560) this.placeWalker(w, px, pz, 150, 420)
      } else if (!w.scripted) {
        // jump clear of a car that is about to arrive
        const closing = pSpeed > 2.5 && ahead > 0 && ahead < 3 + pSpeed * 0.9 && Math.abs(aside) < 2
        if (closing && w.state !== 'flee') {
          w.state = 'flee'
          w.timer = 1.1
          w.fleeSide = Math.sign(aside) || (this.rand() < 0.5 ? -1 : 1)
        }
        if (w.state === 'flee') {
          w.timer -= dt
          const s = w.fleeSide ?? 1
          const quick = w.kind === 'person' ? 4.2 : 7
          w.walkTo(dt, w.x + cosP * s * 3, w.z + sinP * s * 3, quick)
          if (w.timer <= 0) {
            w.state = 'walk'
            w.goal = null
          }
        } else if (w.state === 'wait') {
          w.speed = 0
          w.timer -= dt
          if (w.timer <= 0) w.state = 'walk'
        } else {
          if (!w.goal) {
            const e = g.edges[w.edge]
            w.s += 5
            if (w.s > e.len) {
              // on to the next street
              const end = g.other(e, w.from)
              const options = g.nodes[end].edges.filter((i) => i !== w.edge && g.edges[i].town)
              w.edge = options.length ? options[(this.rand() * options.length) | 0] : w.edge
              w.from = end
              w.s = 2
            }
            const r = this.rand()
            if (r < (w.kind === 'person' ? 0.12 : 0.28)) w.side = -w.side // cross the road
            else if (r < 0.1) {
              w.state = 'wait'
              w.timer = 1 + this.rand() * 4
            }
            w.goal = this.pathPoint(w)
          }
          if (w.goal && w.walkTo(dt, w.goal.x, w.goal.z, w.pace)) w.goal = null
        }
        if (dist > 560 || (w.lost && dist > 120)) this.placeWalker(w, px, pz, 150, 420)
      }
      // The road surface lies about 17 cm above the bare ground, the pavement
      // about 8 cm: stand on whichever is underfoot, judged by the distance to the middle of the road.
      if (w.edge !== undefined) {
        const e = g.edges[w.edge]
        const a = g.nodes[e.a]
        const b = g.nodes[e.b]
        const off = Math.abs((w.x - a.x) * (b.z - a.z) - (w.z - a.z) * (b.x - a.x)) / e.len
        w.lift = off < e.w / 2 ? 0.17 : off < e.w / 2 + 1.8 ? 0.08 : 0.03
      }
      const seen = Math.abs(w.x - view.x) + Math.abs(w.z - view.z) < 220
      if (seen) w.animate(dt, this.terrain)
      w.mesh.visible = seen && !w.hidden
    }
  }
}
