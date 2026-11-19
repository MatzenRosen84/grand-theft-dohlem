import * as THREE from 'three'
import { loadMap } from './mapData.js'
import { paintGround, paintMinimap, buildTerrain, buildBackdrop } from './ground.js'
import { prepareRoads, buildRoads, streetIndex, towardsStreet } from './roads.js'
import { buildBuildings } from './buildings.js'
import { buildTrees } from './trees.js'
import { Environment } from './environment.js'
import { OrbitRig } from './controls.js'
import { RoadGraph } from './roadGraph.js'
import { Vehicle } from './vehicle.js'
import { buildCar, CALIBRA, carLights } from './carModel.js'
import { Population, loadPeople } from './actors.js'
import { TaxiGame } from './taxi.js'
import { createComposer, QUALITY } from './postfx.js'
import { Sound } from './sound.js'
import { Damage } from './damage.js'
import { buildProps } from './props.js'
import { loadModels, makeCalibra, placeModels } from './models.js'
import { canvasTexture } from './textures.js'
import { clamp, lerp } from './util.js'

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))
const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW']
const SHIFT = 300 // one shift lasts five minutes
// the driver's lines, by occasion
const LINES = {
  crash: ['Was kostet die Welt, der Babben bezahlt.'],
  pickup: ['Steig ein ins Gewinnerauto.'],
  dropoff: ['DTHC for life.'],
  fast: ['Put the Pedal to the Metal.', 'Metalsuuuupeeeee.'],
  late: ['Nach der Schicht erstmal in Tripps Keller.'],
}

export class Game {
  // hooks: onProgress(text), onHud(data), onMode(driving), onToast(text, kind),
  //        onSpeech(text), onGameOver({ cash, trips })
  // opts.lite: skip the big character and car models (phones)
  constructor(canvas, hooks = {}, quality = 'medium', opts = {}) {
    this.lite = !!opts.lite
    this.canvas = canvas
    this.hooks = hooks
    this.quality = QUALITY[quality] ? quality : 'medium'
    const q = QUALITY[this.quality]
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: !q.post, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = q.post && q.msaa ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 30000)
    this.env = new Environment(this.scene, this.renderer, q.shadow)
    this.composer = createComposer(this.renderer, this.scene, this.camera, this.quality)
    this.clock = new THREE.Clock()
    this.running = false
    this.frames = 0
    this.hudTimer = 0
    this.minimap = null
    this.shake = 0
    this.noKeys = new Set()
    this.chase = { x: 0, y: 0, z: 0, yaw: 0 }
    this.shift = SHIFT // seconds left on the clock
    // resolution steps the game moves between to keep the frame rate up
    this.scales = [1, 0.9, 0.8, 0.7, 0.6].map((k) => Math.min(window.devicePixelRatio, q.pixelRatio) * k)
    this.scale = 0
    this.pace = { ms: 16.7, since: 0, hold: 0 }

    this.resize = this.resize.bind(this)
    this.tick = this.tick.bind(this)
    this.onKey = (e) => {
      if (e.repeat || e.target instanceof HTMLInputElement || !this.car) return
      if (e.code === 'KeyC') this.setDriving(!this.driving)
      if (e.code === 'KeyR' && this.driving && !this.car.dead) this.resetCar()
      if (e.code === 'KeyL') this.lights = this.lightsOn ? 'off' : 'on'
    }
    window.addEventListener('resize', this.resize)
    window.addEventListener('keydown', this.onKey)
    this.resize()
  }

  async load() {
    // Progress for the loading bar: the building steps count for 40 %, the
    // model downloads for 60 % (phones skip those, so there the steps are everything).
    const STEPS = 10
    let step = 0
    let label = ''
    const bytes = new Map() // file -> [loaded, total]
    const report = () => {
      let loaded = 0
      let total = 0
      for (const [l, t] of bytes.values()) {
        loaded += l
        total += t || l
      }
      const built = Math.min(1, step / STEPS)
      const fetched = total ? loaded / total : this.lite ? 1 : 0
      this.hooks.onProgress?.(label, this.lite ? built : built * 0.4 + fetched * 0.6)
    }
    const say = async (text) => {
      step++
      label = text
      report()
      await nextFrame()
    }
    const onBytes = (file, loaded, total) => {
      bytes.set(file, [loaded, total])
      report()
    }
    // The big files start downloading now and arrive while the village is
    // built, instead of one after the other at the end.
    const peopleReady = this.lite
      ? Promise.resolve(null)
      : loadPeople(onBytes).catch((err) => {
          console.warn('Figuren konnten nicht geladen werden, es bleiben die einfachen:', err)
          return null
        })
    const modelsReady = loadModels(this.lite, onBytes)
    const q = QUALITY[this.quality]

    await say('Karte wird geladen')
    const { map, terrain, outer, baseH } = await loadMap()
    Object.assign(this, { map, terrain, outer, baseH })

    await say('Straßen werden angelegt')
    const runs = prepareRoads(map, terrain)
    this.streetAt = streetIndex(runs)

    await say('Gelände wird geformt')
    this.ground = buildTerrain(terrain, paintGround(map), this.renderer)
    this.scene.add(this.ground)
    this.scene.add(buildBackdrop(outer, map.meta.size))
    this.minimapSource = paintMinimap(map)

    await say('Häuser werden gebaut')
    const buildings = buildBuildings(map, terrain, towardsStreet(runs))
    this.buildings = buildings
    this.scene.add(buildings.group)
    this.scene.add(buildRoads(runs, map, terrain, buildings.near))
    this.graph = new RoadGraph(map, terrain, buildings.near)

    await say('Bäume werden gepflanzt')
    this.trees = buildTrees(map, terrain, buildings)
    this.scene.add(this.trees.group)

    await say('Das Dorf wacht auf')
    await say('Die Leute kommen aus den Häusern')
    const people = await peopleReady
    this.population = new Population(this.scene, this.graph, terrain, { cars: q.cars, people: q.people, dogs: 0, cats: 0 }, people)
    this.peopleModels = people
    this.props = buildProps({ runs, terrain, buildings, graph: this.graph, obstacles: this.population.obstacles, roadFrom: towardsStreet(runs) })
    this.scene.add(this.props.group)
    await say('Der Calibra wird aus der Garage geholt')
    this.models = await modelsReady
    this.placed = placeModels({ models: this.models, map, terrain, graph: this.graph, buildings, obstacles: this.population.obstacles })
    this.scene.add(this.placed.group)
    this.car = new Vehicle({ terrain, buildings, trunksNear: this.trees.trunksNear, obstacles: this.population.obstacles, solids: this.placed.solids })
    this.damage = new Damage(this.scene, terrain)
    this.newCar()
    this.toStart()
    this.lights = 'auto' // auto | on | off

    this.taxi = new TaxiGame({
      scene: this.scene,
      graph: this.graph,
      terrain,
      population: this.population,
      car: this.car,
      map,
      hooks: { onToast: (text, kind) => this.hooks.onToast?.(text, kind), onEvent: (kind) => this.say(kind), onSound: (kind) => this.sound?.ping(kind),onSay: (text) => this.hooks.onSpeech?.(text), onGuest: (name, line) => this.hooks.onGuest?.(name, line) },
    })

    this.taxi.addCustomerAt(this.firstSpot)
    this.scene.add(this.townSign())

    this.rig = new OrbitRig(this.camera, this.canvas, (x, z) => this.groundAt(x, z), map.meta.size / 2 - 30)
    this.setDriving(true)
    Object.assign(this.rig.now, this.rig.goal, { yaw: this.car.yaw })
    this.rig.goal.yaw = this.car.yaw

    this.stats = { buildings: buildings.count, trees: this.trees.count, roads: map.roads.length }
    await say('Der Motor läuft warm')
    await this.warmUp()
    await say('')
    return this.stats
  }

  // ground height anywhere, also on the backdrop hills
  groundAt(x, z) {
    return this.terrain.contains(x, z) ? this.terrain.heightAt(x, z) : this.outer.heightAt(x, z)
  }

  // The shift starts outside the village, at the far end of Neue Straße, and
  // the road in is the way to the first customer. Returns the point `d` metres
  // along that road: { x, z, dx, dz } with the direction of travel.
  wayIn(d) {
    if (!this.approach) {
      const roads = this.map.roads.filter((r) => r.n === 'Neue Straße')
      let far = { x: 0, z: 0 }
      let near = { x: 0, z: 0, d: Infinity }
      for (const r of roads) {
        for (let i = 0; i < r.p.length; i += 2) {
          const dist = Math.hypot(r.p[i], r.p[i + 1])
          if (dist > Math.hypot(far.x, far.z) && this.terrain.contains(r.p[i], r.p[i + 1], 40)) far = { x: r.p[i], z: r.p[i + 1] }
          if (dist < near.d) near = { x: r.p[i], z: r.p[i + 1], d: dist }
        }
      }
      this.approach = this.graph.route(far, near)?.pts ?? [0, 0, 0, -1]
    }
    const p = this.approach
    for (let i = 0; i + 3 < p.length; i += 2) {
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1])
      if (d <= len || i + 5 >= p.length) {
        const t = Math.min(1, d / (len || 1))
        return { x: p[i] + (p[i + 2] - p[i]) * t, z: p[i + 1] + (p[i + 3] - p[i + 1]) * t, dx: (p[i + 2] - p[i]) / (len || 1), dz: (p[i + 3] - p[i + 1]) / (len || 1) }
      }
      d -= len
    }
    return { x: 0, z: 0, dx: 0, dz: -1 }
  }

  // car to the start of the shift, nose towards the village
  toStart() {
    const s = this.wayIn(4)
    this.car.place(s.x, s.z, Math.atan2(s.dx, -s.dz))
    // the first customer waits a little way up the same road, on the right
    const c = this.wayIn(150)
    this.firstSpot = { x: c.x - c.dz * 4.6, z: c.z + c.dx * 4.6, roadX: c.x, roadZ: c.z }
  }

  // yellow town sign on the right of the road where the village begins
  townSign() {
    const at = this.wayIn(60)
    const x = at.x - at.dz * 5.6
    const z = at.z + at.dx * 5.6
    const face = canvasTexture(512, 336, (c, w, h) => {
      c.fillStyle = '#f8cf1c'
      c.fillRect(0, 0, w, h)
      c.strokeStyle = '#111'
      c.lineWidth = 14
      c.strokeRect(12, 12, w - 24, h - 24)
      c.fillStyle = '#111'
      c.textAlign = 'center'
      c.font = 'bold 104px "DIN 1451", Bahnschrift, "Arial Narrow", Arial, sans-serif'
      c.fillText('Thalheim', w / 2, 138)
      c.font = '40px Bahnschrift, "Arial Narrow", Arial, sans-serif'
      c.fillText('Gemeinde Dornburg', w / 2, 196)
      c.fillRect(60, 226, w - 120, 6)
      c.fillText('Kreis Limburg-Weilburg', w / 2, 286)
    })
    face.wrapS = face.wrapT = THREE.ClampToEdgeWrapping
    const sign = new THREE.Group()
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.12), new THREE.MeshStandardMaterial({ map: face, roughness: 0.6 }))
    board.position.set(0, 2.25, 0.02)
    const back = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.12), new THREE.MeshStandardMaterial({ color: 0x8a8d91, roughness: 0.7 }))
    back.position.set(0, 2.25, 0.01)
    back.rotation.y = Math.PI
    sign.add(board, back)
    for (const px of [-0.6, 0.6]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.9, 8), new THREE.MeshStandardMaterial({ color: 0x9a9da3, roughness: 0.5, metalness: 0.5 }))
      post.position.set(px, 1.45, -0.04) // behind the board, which is bolted to their front
      post.castShadow = true
      sign.add(post)
    }
    board.castShadow = true
    sign.position.set(x, this.terrain.heightAt(x, z), z)
    sign.rotation.y = Math.atan2(-at.dx, -at.dz) // faces whoever drives in
    this.population.obstacles.push({ x, z, r: 0.25 })
    return sign
  }

  // a factory-fresh Calibra (also used when starting over after a write-off)
  newCar() {
    if (this.carMesh) this.scene.remove(this.carMesh)
    // the detailed model if it loaded, otherwise the built-in one
    this.carMesh = this.models?.calibra ? makeCalibra(this.models.calibra) : buildCar(CALIBRA, { stripes: 0xf4f4f0 })
    this.scene.add(this.carMesh)
    // headlight beams, one per side
    this.beams = [-1, 1].map((side) => {
      const beam = new THREE.SpotLight(0xfff1d8, 0, 110, 0.5, 0.65, 1.6)
      beam.position.set(side * 0.55, 0.62, -2.05)
      beam.target.position.set(side * 0.9, -0.4, -30)
      beam.visible = false
      this.carMesh.userData.body.add(beam, beam.target)
      return beam
    })
    // soft red glow around the tail lights; brighter under braking
    this.glowTex ??= canvasTexture(64, 64, (c, w) => {
      const g = c.createRadialGradient(w / 2, w / 2, 1, w / 2, w / 2, w / 2)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.3, 'rgba(255,255,255,0.35)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = g
      c.fillRect(0, 0, w, w)
    })
    this.tailGlow = new THREE.SpriteMaterial({ map: this.glowTex, color: 0xff2a14, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })
    for (const side of [-1, 1]) {
      const s = new THREE.Sprite(this.tailGlow)
      s.position.set(side * 0.57, 0.7, 2.3)
      s.scale.setScalar(1.1)
      this.carMesh.userData.body.add(s)
    }
    this.lightsOn = null // re-apply the light state to the new lamps
    this.damage.reset(this.carMesh)
    this.car.power = 1
    this.car.dead = false
    this.car.limp = null
    this.over = false
    this.shift = SHIFT
  }

  // new car, empty till, back to the middle of the village
  restart() {
    this.newCar()
    this.taxi.reset()
    this.toStart()
    this.taxi.addCustomerAt(this.firstSpot)
  }

  // the driver comments on what just happened; `gap` seconds must have passed since the same kind of line
  say(kind, gap = 0) {
    this.said ??= {}
    const now = performance.now() / 1000
    if (now - (this.said[kind] ?? -1e9) < gap) return
    this.said[kind] = now
    const lines = LINES[kind]
    this.hooks.onSpeech?.(lines[(Math.random() * lines.length) | 0])
  }

  // every crash costs bodywork, and in the end the engine
  crashes(dt) {
    const car = this.car
    const dmg = this.damage
    if (dmg.crash(car) > 0) {
      this.say('crash')
      // from half damage the engine loses power; at 100 % it is gone
      car.power = dmg.level < 50 ? 1 : 1 - ((dmg.level - 50) / 50) * 0.6
      if (dmg.level >= 100) car.dead = true
    }
    dmg.update(dt, car)
    if (this.over) return
    if (car.throttle > 0.9 && car.kmh > 95) this.say('fast', 40)
    if (this.shift > 30 && this.shift - dt <= 30) this.say('late')
    this.shift -= dt
    // the shift ends when the clock runs out or the car is a write-off
    const wrecked = car.dead && car.speed < 0.6
    if (wrecked || this.shift <= 0) {
      this.over = true
      this.shift = Math.max(0, this.shift)
      this.hooks.onGameOver?.({ cash: this.taxi.cash, trips: this.taxi.trips, reason: wrecked ? 'wreck' : 'time' })
    }
  }

  // back onto the nearest street, pointing along it
  resetCar(at = this.car) {
    const spot = this.graph.nearest(at.x, at.z)
    if (!spot) return
    const p = this.graph.point(spot.edge, spot.t)
    this.car.place(spot.x, spot.z, Math.atan2(p.dx, -p.dz))
  }

  setTime(hours) {
    this.env.setTime(hours)
  }

  // true: drive the taxi. false: free camera for looking around
  setDriving(on) {
    if (!this.rig) return
    this.driving = on
    const g = this.rig.goal
    if (on) {
      this.rig.follow = this.chase
      this.rig.idle = 9
      Object.assign(g, { dist: 7.6, pitch: 0.2 })
    } else {
      this.rig.follow = null
      Object.assign(g, { dist: 160, pitch: 0.6 })
    }
    this.hooks.onMode?.(on)
  }

  attachMinimap(canvas) {
    this.minimap = canvas
  }

  start() {
    if (this.running) return
    this.running = true
    // start() comes from the click on the splash screen, which is what lets the browser play sound
    try {
      this.sound ??= new Sound()
    } catch (err) {
      console.warn('Kein Ton:', err)
    }
    this.clock.start()
    this.raf = requestAnimationFrame(this.tick)
  }

  tick() {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.tick)
    const raw = this.clock.getDelta()
    const dt = Math.min(raw, 0.05)
    const car = this.car
    this.keepPace(raw)

    const live = !this.frozen // false during story and countdown: the village moves, the shift has not begun
    car.update(dt, live && this.driving && !this.over ? this.rig.keys : this.noKeys)
    this.population.update(dt, car, this.rig.target)
    if (live) {
      this.crashes(dt)
      this.placed.step(dt, car)
      this.taxi.update(dt)
    }
    this.poseCar()
    this.sound?.update(dt, car, !!this.over)

    // chase camera: behind the direction of travel, so slides show
    const c = this.chase
    c.x = car.x
    c.y = car.y
    c.z = car.z
    const vf = car.forwardSpeed
    c.yaw = vf > 6 ? Math.atan2(car.vx, -car.vz) : car.yaw
    this.rig.update(dt)
    if (this.driving) {
      if (car.impact > 2.5) this.shake = Math.min(1, car.impact / 14)
      this.shake *= Math.exp(-dt * 6)
      const s = this.shake * 0.25
      this.camera.position.x += (Math.random() - 0.5) * s
      this.camera.position.y += (Math.random() - 0.5) * s
      const fov = lerp(55, 72, clamp(car.speed / 55, 0, 1))
      if (Math.abs(fov - this.camera.fov) > 0.05) {
        this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3)
        this.camera.updateProjectionMatrix()
      }
    }

    this.draw(dt)
    if ((this.frameNo = (this.frameNo ?? 0) + 1) & 1) this.drawMinimap() // the radar is fine at half rate
    this.hudTick(dt)
  }

  // The first picture is the expensive one: every shader gets compiled and
  // every texture and mesh goes to the graphics card. Do that behind the
  // loading screen, so the game does not hang after the click on start.
  async warmUp() {
    this.poseCar()
    this.rig.update(1 / 60)
    try {
      await this.renderer.compileAsync?.(this.scene, this.camera)
    } catch (err) {
      console.warn('Shader konnten nicht vorab übersetzt werden:', err)
    }
    this.draw(1 / 60)
  }

  // one picture from where the camera is now
  draw(dt) {
    this.trees.update(this.camera.position.x, this.camera.position.z)
    this.props.update(this.camera.position.x, this.camera.position.z, this.env.dark)
    this.placed.update(this.camera.position.x, this.camera.position.z)
    this.ground.userData.update(this.camera.position.x, this.camera.position.z)
    this.env.follow(this.rig.target, this.rig.now.dist)
    if (this.composer) {
      const u = this.composer.finish.uniforms
      u.tDepth.value = this.composer.sceneDepth()
      u.exposure.value = this.renderer.toneMappingExposure
      u.time.value = performance.now() / 1000
      u.focus.value = this.rig.now.dist
      // once the resolution had to come down, the blur goes first: the card is struggling
      u.radius.value = this.scale > 0 ? 0 : this.composer.blur * this.renderer.getPixelRatio()
      u.near.value = this.camera.near
      u.far.value = this.camera.far
      u.texel.value.set(1 / this.composer.readBuffer.width, 1 / this.composer.readBuffer.height)
      this.composer.render(dt)
    }
    else this.renderer.render(this.scene, this.camera)
  }

  // numbers for the dashboard, five times a second
  hudTick(dt) {
    const car = this.car
    this.frames++
    this.hudTimer += dt
    if (this.hudTimer >= 0.2) {
      const { x, z } = this.rig.target
      const turn = ((this.rig.now.yaw / (Math.PI * 2)) % 1 + 1) % 1
      this.hooks.onHud?.({
        street: this.streetAt(x, z) ?? '',
        compass: COMPASS[Math.round(turn * 8) % 8],
        altitude: Math.round(this.baseH + this.groundAt(x, z)),
        fps: Math.round(this.frames / this.hudTimer),
        scale: Math.round((this.scales[this.scale] / this.scales[0]) * 100),
        speed: Math.round(car.kmh),
        gear: car.gear === -1 ? 'R' : String(car.gear),
        lights: this.lightsOn,
        damage: Math.round(this.damage.level),
        shift: this.shift,
        rpm: car.rpm / 6800,
        taxi: this.taxi.status,
      })
      this.frames = 0
      this.hudTimer = 0
    }
  }

  // Hold 60 fps by rendering fewer pixels when frames take too long, and go
  // back up when there is room again. dt: real time since the last frame.
  keepPace(dt) {
    const p = this.pace
    if (document.hidden || dt > 0.25) return
    p.ms += (dt * 1000 - p.ms) * 0.05
    p.since += dt
    p.hold -= dt
    // Already at the lowest resolution and still far from smooth: this graphics
    // card is too weak for the full game. Say so once; the next start is lighter.
    const stuck = this.scale === this.scales.length - 1 && p.ms > 28
    p.slow = stuck ? (p.slow ?? 0) + dt : 0
    if (p.slow > 6 && !this.lite && !p.told) {
      p.told = true
      this.hooks.onSlow?.()
    }
    if (p.since < 2) return // let the average settle after a change
    let next = this.scale
    if (p.ms > 18 && this.scale < this.scales.length - 1) {
      next++
      if (p.raised) p.hold = 60 // going up did not work out; don't retry for a while
    } else if (p.ms < 17 && this.scale > 0 && p.since > 8 && p.hold <= 0) next--
    if (next === this.scale) return
    p.raised = next < this.scale
    this.scale = next
    p.since = 0
    p.ms = 16.7
    this.renderer.setPixelRatio(this.scales[next])
    this.resize()
  }

  // copy the physics state onto the model
  poseCar() {
    const car = this.car
    const m = this.carMesh
    m.position.set(car.x, car.y, car.z)
    m.rotation.set(car.pitch, -car.yaw, car.roll)
    const { wheels, tail, body } = m.userData
    // with a wheel gone the body sags onto that corner
    const sag = car.limp ? 0.05 : 0
    body.rotation.set(car.dive + (car.limp ? (car.limp.front ? -sag : sag) * 0.6 : 0), 0, car.lean - (car.limp ? car.limp.side * sag : 0))
    for (const w of wheels) {
      w.spinner.rotation.x = -car.wheelSpin
      if (w.front) w.pivot.rotation.y = -car.steer
    }
    // lights come on by themselves at dusk; L overrides
    const on = this.lights === 'on' || (this.lights === 'auto' && this.env.dark > 0.35)
    if (on !== this.lightsOn) {
      this.lightsOn = on
      carLights(on)
      for (const b of this.beams) {
        b.intensity = on ? 900 : 0
        b.visible = on // an unlit lamp would still cost shading time
      }
    }
    tail.emissiveIntensity = car.braking ? 6 : on ? 1.6 : 0.2
    this.tailGlow.opacity = car.braking ? 0.85 : on ? 0.3 : 0
  }

  drawMinimap() {
    const cv = this.minimap
    if (!cv || !this.minimapSource) return
    const ctx = cv.getContext('2d')
    const w = cv.width
    const h = cv.height
    const size = this.map.meta.size
    const { x, z } = this.rig.target
    const yaw = this.rig.now.yaw
    const view = this.driving ? 320 + this.car.speed * 6 : this.rig.now.dist * 1.6
    const across = clamp(view, 260, 2400) // metres shown across the radar
    const scale = w / across
    const cy = h * 0.6

    ctx.fillStyle = '#3d4a3a'
    ctx.fillRect(0, 0, w, h)
    ctx.save()
    ctx.translate(w / 2, cy)
    ctx.rotate(-yaw)
    ctx.scale(scale, scale)
    ctx.translate(-x, -z)
    ctx.drawImage(this.minimapSource, -size / 2, -size / 2, size, size)

    // GPS line to the destination
    const route = this.taxi?.route
    if (route) {
      ctx.strokeStyle = '#ff3fa4'
      ctx.lineWidth = 5 / scale
      ctx.lineJoin = ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(this.car.x, this.car.z)
      for (let i = 0; i < route.pts.length; i += 2) ctx.lineTo(route.pts[i], route.pts[i + 1])
      ctx.stroke()
    }
    ctx.restore()

    // customers and destination; pinned to the rim while off the map
    const sin = Math.sin(-yaw)
    const cos = Math.cos(-yaw)
    for (const b of this.taxi?.blips ?? []) {
      const dx = (b.x - x) * scale
      const dz = (b.z - z) * scale
      let bx = dx * cos - dz * sin
      let by = dx * sin + dz * cos
      const k = Math.max(Math.abs(bx) / (w / 2 - 12), by < 0 ? -by / (cy - 12) : by / (h - cy - 12), 1)
      bx = w / 2 + bx / k
      by = cy + by / k
      ctx.fillStyle = b.color
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(bx, by, b.big ? 9 : 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    // the car (or the camera, when looking around)
    ctx.save()
    ctx.translate(w / 2, cy)
    if (this.driving) ctx.rotate(this.car.yaw - yaw)
    ctx.fillStyle = '#ffffff'
    ctx.strokeStyle = 'rgba(0,0,0,0.7)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, -12)
    ctx.lineTo(8, 9)
    ctx.lineTo(0, 4)
    ctx.lineTo(-8, 9)
    ctx.closePath()
    ctx.stroke()
    ctx.fill()
    ctx.restore()

    // north marker on the rim
    const r = Math.min(w / 2, cy) - 14
    const nx = w / 2 + Math.sin(-yaw) * r
    const ny = cy - Math.cos(-yaw) * r
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.beginPath()
    ctx.arc(nx, ny, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', nx, ny + 1)
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.composer?.setPixelRatio(this.renderer.getPixelRatio())
    this.composer?.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.running = false
    cancelAnimationFrame(this.raf)
    window.removeEventListener('resize', this.resize)
    window.removeEventListener('keydown', this.onKey)
    this.rig?.dispose()
    this.sound?.dispose()
    this.scene.traverse((o) => {
      o.geometry?.dispose()
      for (const m of [].concat(o.material ?? [])) {
        m.map?.dispose()
        m.dispose()
      }
    })
    this.renderer.dispose()
  }
}
