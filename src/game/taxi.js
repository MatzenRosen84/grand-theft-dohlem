import * as THREE from 'three'
import { rng, clamp } from './util.js'

// The taxi job: find a waving customer, stop next to them, drive them where
// they want to go. Quick, smooth trips earn a tip; knocking things over costs money.

// The regulars. Each one has had a few, says his piece when he gets in, and
// always wants to go to the same place. `to` says how to find that place on the map:
//   addr: street and house number     building / poi: something with that name
//   street: anywhere on that street   end: the end of a street lying in a compass direction
//   at: map coordinates in metres, for places the map data has no name for
const CAST = [
  { name: 'Hackstyle', line: 'Bring mich zurück zur Mony, aber schnell. Sonst kübel ich dir den Calibra voll.', label: 'Mühlenweg 22', to: { addr: 'Mühlenweg 22' } },
  { name: 'Tripp', line: 'Bring mich in den Keller, aber schnell. Die Huga qualmt schon.', label: 'Röder 3', to: { addr: 'Röder 3' } },
  { name: 'Kriz Schürgo', line: 'Ich bin so tapeziert. Fahr mich direkt auf den Friedhof.', label: 'Friedhof', to: { poi: 'Friedhof Thalheim' } },
  { name: 'Arne', line: 'Ich bin nicht stolz auf das, was ich heute an dem Abend gemacht hab. Fahr mich zum Beichten zum Pfarrer, aber flotti.', label: 'Pfarrer', to: { building: 'Pfarrheim' } },
  { name: 'Collin Mc Marius', line: 'Lass mich fahren, dann sind wir schneller da! Ich penn heute nicht bei meinem besten Freund Zey. Fahr mich zum Rosenthal.', label: 'Langgasse 57', to: { addr: 'Langgasse 57' } },
  { name: 'Zeyjung', line: 'Fahr mich nochmal ins Sportheim, ich will doch noch 5-6 Whisky Colabier trinken.', label: 'Sportheim, Am Sportplatz', to: { street: 'Am Sportplatz' } },
  { name: 'Rosen', line: 'Ich hab mir ordentlich die Rüstung verbaut. Bring mich heim, aber zappo. Ich hoffe, der Marius liegt noch nicht in der Kiste.', label: 'Langgasse 57', to: { addr: 'Langgasse 57' } },
  { name: 'Shokky', line: 'Keine Sekunde bleibe ich länger in dem Kaff hier. Ab nach Frickhofen, aber lass mich ruhig am Feldweg raus.', label: 'Jagdweg, am Ende', to: { end: 'Jagdweg', east: 0.7, north: 0.7 } },
  { name: 'Opti', line: 'Schnell zurück in meine Bude. Ach was, lass mich an meinem Auto raus, ich fahr noch selbst. Steht am Grillplatz.', label: 'Grillplatz', to: { at: [-1055, -252] } }, // Grillplatz Thalheim, Hof Unter den Linden 1
  { name: 'Schoska', line: 'Ein Absacker noch beim Jansen, aber schnell.', label: 'Auf der Hahr 3', to: { addr: 'Auf der Hahr 3' } },
  { name: 'Hugo', line: 'Ab nach Dorndorf, aber schnell. Ich hab erst 10 Weizen getrunken und muss da noch nen Baum wegsprengen. Dorfrand langt.', label: 'Jagdweg', to: { end: 'Jagdweg', east: -0.8, north: 0.6 } },
]

const BASE_FARE = 3.9
const PER_KM = 2.3
const FINES = { person: 60, dog: 40, cat: 40, car: 35 }
const WAITING = 3 // customers on the map at once

function beacon(color, radius) {
  const g = new THREE.Group()
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, 0.5, 40, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }),
  )
  ring.position.y = 0.3
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 60, 12, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }),
  )
  beam.position.y = 30
  g.add(ring, beam)
  g.userData.ring = ring
  return g
}

export class TaxiGame {
  constructor({ scene, graph, terrain, population, car, map, hooks }) {
    Object.assign(this, { scene, graph, terrain, population, car, hooks })
    this.rand = rng(Date.now() & 0xffff)
    // find everybody's destination on the map once
    this.cast = []
    for (const c of CAST) {
      const at = this.locate(c.to, map)
      const near = at && graph.nearest(at.x, at.z)
      if (!near) {
        console.warn(`Ziel von ${c.name} nicht auf der Karte gefunden:`, c.label)
        continue
      }
      // stop at the kerb on the side of the road the place is on
      const e = graph.edges[near.edge]
      const a = graph.point(near.edge, near.t, e.w / 2 + 1.1)
      const b = graph.point(near.edge, near.t, -(e.w / 2 + 1.1))
      const kerb = Math.hypot(a.x - at.x, a.z - at.z) < Math.hypot(b.x - at.x, b.z - at.z) ? a : b
      this.cast.push({ ...c, dest: { x: kerb.x, z: kerb.z, roadX: near.x, roadZ: near.z, label: c.label, name: c.name, line: c.line } })
    }
    this.cash = 0
    this.trips = 0
    this.state = 'cruise' // cruise | boarding | fare | leaving
    this.customers = []
    this.rider = null
    this.route = null
    this.routeTimer = 0
    this.destMarker = beacon(0xff3fa4, 4)
    this.destMarker.visible = false
    scene.add(this.destMarker)
    this.clock = 0
  }

  toast(text, kind = 'info') {
    this.hooks.onToast?.(text, kind)
  }

  ground(o, x, z) {
    o.position.set(x, this.terrain.heightAt(x, z), z)
  }

  // where on the map a place from CAST is: { x, z } or null
  locate(to, map) {
    const middle = (p) => {
      let x = 0
      let z = 0
      for (let i = 0; i < p.length; i += 2) {
        x += (p[i] * 2) / p.length
        z += (p[i + 1] * 2) / p.length
      }
      return { x, z }
    }
    if (to.at) return { x: to.at[0], z: to.at[1] }
    if (to.addr) {
      const b = map.buildings.find((k) => k.addr === to.addr)
      return b ? middle(b.p) : null
    }
    if (to.building) {
      const b = map.buildings.find((k) => k.n?.includes(to.building))
      return b ? middle(b.p) : null
    }
    if (to.poi) return map.pois.find((k) => k.n === to.poi) ?? null
    const roads = map.roads.filter((r) => r.n === (to.street ?? to.end))
    if (!roads.length) return null
    if (to.street) return middle(roads[0].p)
    // the point of that street lying furthest in the given direction (+z is south)
    let best = null
    let score = -Infinity
    for (const r of roads) {
      for (let i = 0; i < r.p.length; i += 2) {
        if (!this.terrain.contains(r.p[i], r.p[i + 1], 40)) continue
        const s = r.p[i] * to.east - r.p[i + 1] * to.north
        if (s > score) {
          score = s
          best = { x: r.p[i], z: r.p[i + 1] }
        }
      }
    }
    return best
  }

  // one of the regulars who isn't out already and whose trip from here is worth the fare
  destinationFor(from) {
    const busy = new Set(this.customers.map((c) => c.name))
    if (this.rider) busy.add(this.rider.name)
    const free = this.cast.filter((c) => !busy.has(c.name))
    for (let tries = 0; tries < 12 && free.length; tries++) {
      const pick = free[(this.rand() * free.length) | 0]
      const route = this.graph.route({ x: from.roadX, z: from.roadZ }, { x: pick.dest.roadX, z: pick.dest.roadZ })
      if (route && route.len > 250) return { ...pick.dest, dist: route.len }
    }
    return null
  }

  addCustomer() {
    for (let tries = 0; tries < 30; tries++) {
      const spot = this.graph.randomSpot(this.rand)
      const d = Math.hypot(spot.x - this.car.x, spot.z - this.car.z)
      // always keep one customer a short drive away; the others may wait further out
      const oneClose = this.customers.some((c) => Math.hypot(c.spot.x - this.car.x, c.spot.z - this.car.z) < 300)
      // (out in the sticks there may be no street that close; then take the nearest that turns up)
      if (d < 60 || d > (oneClose ? 600 : tries < 18 ? 260 : 900)) continue
      if (this.customers.some((c) => Math.hypot(c.spot.x - spot.x, c.spot.z - spot.z) < 120)) continue
      const dest = this.destinationFor(spot)
      if (!dest) continue
      this.spawn(spot, dest)
      return
    }
  }

  // put a waving customer at a kerb spot: { x, z, roadX, roadZ }
  spawn(spot, dest) {
    const person = this.population.createPerson()
    person.x = spot.x
    person.z = spot.z
    person.wave = true
    person.yaw = Math.atan2(spot.roadX - spot.x, -(spot.roadZ - spot.z))
    const marker = beacon(0xffc41f, 2.4)
    this.ground(marker, spot.roadX, spot.roadZ)
    this.scene.add(marker)
    this.customers.push({ person, spot, dest, name: dest.name, marker })
  }

  // a customer exactly here (the easy first pick-up); makes room if the map is full
  addCustomerAt(spot) {
    const far = (c) => Math.hypot(c.spot.x - spot.x, c.spot.z - spot.z)
    if (this.customers.some((c) => far(c) < 40)) return
    if (this.customers.length >= WAITING) {
      const gone = this.customers.reduce((a, b) => (far(a) > far(b) ? a : b))
      this.customers.splice(this.customers.indexOf(gone), 1)
      this.scene.remove(gone.marker)
      this.population.remove(gone.person)
    }
    const dest = this.destinationFor(spot)
    if (dest) this.spawn(spot, dest)
  }

  update(dt) {
    const car = this.car
    this.clock += dt
    while (this.customers.length < WAITING) {
      const before = this.customers.length
      this.addCustomer()
      if (this.customers.length === before) break
    }

    // accidents
    for (const ev of this.population.events) {
      const fine = FINES[ev.type] ?? 0
      this.cash -= fine
      const what = { person: 'Jemanden angefahren', dog: 'Hund angefahren', cat: 'Katze angefahren', car: 'In ein Auto gekracht' }[ev.type]
      this.toast(`${what}: −${fine} €`, 'bad')
      if (this.rider) this.rider.scares++
    }
    this.population.events.length = 0
    if (car.impact > 4) {
      if (this.rider && this.clock - (this.lastBump ?? -9) > 2) {
        this.rider.scares++
        this.hooks.onGuest?.(this.rider.name, ['Vorsicht!', 'Ei, pass doch uff!', 'Mir wird schlecht.'][(this.rand() * 3) | 0])
      }
      this.lastBump = this.clock
    }

    const stopped = car.speed < 1.3
    const pulse = 1 + Math.sin(this.clock * 4) * 0.06

    if (this.state === 'cruise') {
      for (const c of this.customers) {
        c.marker.userData.ring.scale.set(pulse, 1, pulse)
        c.person.wave = c.person.state !== 'down'
        if (stopped && Math.hypot(c.spot.roadX - car.x, c.spot.roadZ - car.z) < 7.5 && c.person.state !== 'down') {
          this.state = 'boarding'
          this.rider = { ...c, scares: 0 }
          this.customers.splice(this.customers.indexOf(c), 1)
          this.scene.remove(c.marker)
          c.person.wave = false
          this.hooks.onGuest?.(c.name, c.dest.line)
          this.hooks.onEvent?.('pickup')
          break
        }
      }
    } else if (this.state === 'boarding') {
      // walk to the passenger door
      const p = this.rider.person
      const side = { x: car.x + Math.cos(car.yaw) * 1.15, z: car.z + Math.sin(car.yaw) * 1.15 }
      if (car.speed > 3) {
        // drove off without them
        this.customers.push({ ...this.rider })
        this.scene.add(this.rider.marker)
        p.wave = true
        p.speed = 0
        this.rider = null
        this.state = 'cruise'
      } else {
        // they are simply in the car; no walking to the door
        p.hidden = true
        p.x = 1e6 // out of the way of traffic and wheels
        const d = this.rider.dest
        this.state = 'fare'
        this.fareStart = this.clock
        this.rider.par = d.dist / 9 + 20 // seconds a decent driver needs
        this.rider.limit = this.rider.par * 1.7
        this.ground(this.destMarker, d.roadX, d.roadZ)
        this.destMarker.visible = true
        this.routeTimer = 0
      }
    } else if (this.state === 'fare') {
      const d = this.rider.dest
      this.destMarker.userData.ring.scale.set(pulse, 1, pulse)
      this.routeTimer -= dt
      if (this.routeTimer <= 0) {
        this.routeTimer = 1
        this.route = this.graph.route({ x: car.x, z: car.z }, { x: d.roadX, z: d.roadZ })
      }
      if (stopped && Math.hypot(d.roadX - car.x, d.roadZ - car.z) < 8) this.dropOff()
      else if (stopped && this.clock - (this.lastFull ?? -99) > 6 && this.customers.some((k) => Math.hypot(k.spot.roadX - car.x, k.spot.roadZ - car.z) < 7.5)) {
        // stopped next to another hitchhiker with someone already on board
        this.lastFull = this.clock
        this.hooks.onSay?.(`Voll besetzt! Erst muss ${this.rider.name} raus.`)
      }
    } else if (this.state === 'leaving') {
      const p = this.rider.person
      const d = this.rider.dest
      this.leaveTimer -= dt
      if (this.leaveTimer <= 0) {
        this.population.park(p)
        this.rider = null
        this.state = 'cruise'
      }
    }
  }

  dropOff() {
    const r = this.rider
    const elapsed = this.clock - this.fareStart
    const fare = BASE_FARE + (r.dest.dist / 1000) * PER_KM
    // full tip at par time or better, none once the patience runs out; bumps cost a quarter each
    const punctual = clamp((r.limit - elapsed) / (r.limit - r.par), 0, 1)
    const tip = Math.max(0, fare * 0.6 * punctual * (1 - r.scares * 0.25))
    const total = Math.round((fare + tip) * 10) / 10
    this.cash += total
    this.trips++
    this.hooks.onEvent?.('dropoff')
    const mood = r.scares > 1 ? 'Nie wieder!' : punctual > 0.7 ? 'Das ging ja flott, danke!' : punctual > 0 ? 'Danke.' : 'Das hat aber gedauert.'
    this.hooks.onGuest?.(r.name, mood)
    this.toast(`+${total.toFixed(2).replace('.', ',')} €${tip >= 0.5 ? ` (Trinkgeld ${tip.toFixed(2).replace('.', ',')} €)` : ''}`, 'good')

    const p = r.person
    p.hidden = false
    // they are simply standing at the kerb of their destination, waving goodbye
    p.x = r.dest.x
    p.z = r.dest.z
    p.yaw = Math.atan2(r.dest.roadX - r.dest.x, -(r.dest.roadZ - r.dest.z))
    p.wave = true
    p.state = 'idle'
    this.destMarker.visible = false
    this.route = null
    this.state = 'leaving'
    this.leaveTimer = 1.5

    // nobody waiting nearby? Then the one furthest away gives up, and the
    // next customer turns up a short drive from here.
    const far = (c) => Math.hypot(c.spot.x - this.car.x, c.spot.z - this.car.z)
    if (this.customers.length && !this.customers.some((c) => far(c) < 300)) {
      const gone = this.customers.reduce((a, b) => (far(a) > far(b) ? a : b))
      this.customers.splice(this.customers.indexOf(gone), 1)
      this.scene.remove(gone.marker)
      this.population.remove(gone.person)
    }
  }

  // back to an empty taxi and an empty till
  reset() {
    if (this.rider) {
      const p = this.rider.person
      p.hidden = false
      p.x = this.car.x + Math.cos(this.car.yaw) * 1.3
      p.z = this.car.z + Math.sin(this.car.yaw) * 1.3
      this.population.remove(p)
    }
    this.rider = null
    this.route = null
    this.destMarker.visible = false
    this.state = 'cruise'
    this.cash = 0
    this.trips = 0
  }

  // what the HUD and the radar show
  get status() {
    const r = this.rider
    const out = { cash: this.cash, trips: this.trips, state: this.state, text: 'Sammel einen Besoffskie ein', timeLeft: null, distance: null }
    if (this.state === 'boarding') out.text = `${r.name} steigt ein`
    if (this.state === 'fare') {
      out.text = `${r.name} → ${r.dest.label}`
      out.timeLeft = Math.max(0, r.limit - (this.clock - this.fareStart))
      out.patience = clamp(out.timeLeft / r.limit, 0, 1)
      out.distance = this.route?.len ?? Math.hypot(r.dest.x - this.car.x, r.dest.z - this.car.z)
    }
    if (this.state === 'cruise' && this.customers.length) {
      out.distance = Math.min(...this.customers.map((c) => Math.hypot(c.spot.x - this.car.x, c.spot.z - this.car.z)))
    }
    return out
  }

  get blips() {
    const list = this.state === 'cruise' ? this.customers.map((c) => ({ x: c.spot.roadX, z: c.spot.roadZ, color: '#ffc41f' })) : []
    if (this.state === 'fare') list.push({ x: this.rider.dest.roadX, z: this.rider.dest.roadZ, color: '#ff3fa4', big: true })
    return list
  }
}
