import { clamp, lerp, smoothstep, inRing } from './util.js'

// Driving physics for the Calibra 2.0i 16V: front-wheel drive, 150 PS, five gears.
// A two-axle ("bicycle") model with tyre slip angles, load transfer, a friction
// circle per axle, an engine torque curve and an automatic gearbox.
//
// Conventions: yaw 0 looks north (-z), positive yaw turns right (east).
// forward = (sin yaw, -cos yaw), right = (cos yaw, sin yaw).

const G = 9.81
const MASS = 1250
const INERTIA = 2000 // yaw, kg m²
export const WHEELBASE = 2.6
const CG_FRONT = 1.08 // centre of gravity to front axle; nose-heavy like any FWD car
const CG_REAR = WHEELBASE - CG_FRONT
const CG_HEIGHT = 0.5
export const TRACK = 1.48
export const WHEEL_R = 0.31
const GEARS = [3.55, 2.16, 1.48, 1.13, 0.89]
const REVERSE = 3.33
const FINAL = 3.72
const IDLE = 900
const REDLINE = 6800
const PEAK_TORQUE = 160 // Nm; the real car has 196, toned down so the village stays drivable
const TOP_SPEED = 31 // m/s, about 110 km/h: the engine fades out towards it
const DRIVELINE = 0.9
const BRAKE_FORCE = 18000 // N, all four wheels
const DRAG = 0.3 // 0.5 * rho * cd * A
const MAX_LOCK = 0.6 // rad at the front wheels
const SUBSTEP = 1 / 240

// tyre curve: grip rises with slip angle, peaks around 8 degrees, then falls off a little
const tyre = (alpha) => Math.sin(1.45 * Math.atan(9.5 * alpha))

const torqueAt = (rpm) => {
  const x = (rpm - 4800) / 5200
  return PEAK_TORQUE * Math.max(0.35, 1 - x * x)
}

// outline points checked against walls: [forward, right]
const HULL = [[2.2, 0.75], [2.2, -0.75], [-2.2, 0.75], [-2.2, -0.75], [0, 0.84], [0, -0.84], [2.25, 0], [-2.25, 0]]
// circles checked against trees and other cars: forward offset, radius
const BUMPERS = [[1.4, 0.85], [0, 0.85], [-1.4, 0.85]]

export class Vehicle {
  // world: { terrain, buildings, trunksNear(x, z, fn), obstacles: [{x, z, r, hit(speed)}] }
  constructor(world) {
    this.world = world
    this.x = 0
    this.y = 0
    this.z = 0
    this.yaw = 0
    this.vx = 0
    this.vz = 0
    this.vy = 0
    this.spinRate = 0 // yaw rate
    this.steer = 0 // current front wheel angle
    this.steerIn = 0
    this.throttle = 0
    this.brake = 0
    this.gear = 1 // -1 reverse, 1..5
    this.shift = 0 // seconds left in a gear change
    this.rpm = IDLE
    this.ax = 0
    this.ay = 0
    this.pitch = 0 // from the ground
    this.roll = 0
    this.lean = 0 // body roll from cornering
    this.dive = 0 // body pitch from braking and accelerating
    this.wheelSpin = 0
    this.airborne = false
    this.slip = 0 // 0..1, how hard the tyres are sliding
    this.impact = 0 // hardest hit this frame, m/s
    this.braking = false
    this.power = 1 // engine health, 1 = sound
    this.dead = false // engine gone for good
    this.limp = null // { side, front } once a wheel has come off
    this.hit = null // hardest contact this frame: { x, z, v }
  }

  get speed() {
    return Math.hypot(this.vx, this.vz)
  }
  get kmh() {
    return this.speed * 3.6
  }
  get forwardSpeed() {
    return this.vx * Math.sin(this.yaw) - this.vz * Math.cos(this.yaw)
  }

  place(x, z, yaw) {
    Object.assign(this, { x, z, yaw, vx: 0, vz: 0, vy: 0, spinRate: 0, gear: 1, steer: 0, ax: 0, ay: 0, lean: 0, dive: 0 })
    this.y = this.groundPose().y
    this.sit(1)
  }

  update(dt, keys) {
    const gasKey = keys.has('KeyW') || keys.has('ArrowUp')
    const brakeKey = keys.has('KeyS') || keys.has('ArrowDown')
    const turn = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0)
    this.handbrake = keys.has('Space')

    // S brakes; once stopped it selects reverse, and then W is the brake
    const vf = this.forwardSpeed
    if (this.gear === -1 && gasKey && !brakeKey && vf > -0.6) this.gear = 1
    else if (this.gear > 0 && brakeKey && !gasKey && vf < 0.6 && this.speed < 1) this.gear = -1
    const wantGas = !this.dead && (this.gear === -1 ? brakeKey : gasKey)
    const wantBrake = this.gear === -1 ? gasKey : brakeKey

    const ease = (v, to, up, down) => (to > v ? Math.min(to, v + up * dt) : Math.max(to, v - down * dt))
    this.throttle = ease(this.throttle, wantGas ? 1 : 0, 5, 9)
    this.brake = ease(this.brake, wantBrake ? 1 : 0, 6, 10)
    // hands turn the wheel at a finite rate, and less far at speed
    const rate = turn === 0 || Math.sign(turn) !== Math.sign(this.steerIn) ? 4.5 : 2.6
    this.steerIn = ease(this.steerIn, turn, rate, rate)
    const lock = MAX_LOCK / (1 + (this.speed / 13) ** 2)
    this.steer = this.steerIn * Math.max(lock, 0.035)
    // on three wheels the car drags towards the bare corner
    if (this.limp) this.steer += this.limp.side * 0.045 * Math.min(1, this.speed / 6)
    this.braking = this.brake > 0.1 || this.handbrake

    this.impact = 0
    this.hit = null
    const steps = Math.max(1, Math.ceil(dt / SUBSTEP))
    for (let i = 0; i < steps; i++) this.step(dt / steps)
    this.sit(dt)
  }

  step(h) {
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    let vf = this.vx * sin - this.vz * cos // forward speed
    let vr = this.vx * cos + this.vz * sin // sideways speed, positive to the right
    const w = this.spinRate
    const speed = Math.hypot(vf, vr)
    const onRoad = this.world.terrain.nearRoad(this.x, this.z)
    const mu = this.airborne ? 0 : onRoad ? 1.3 : 0.75 // stickier than real tyres, to forgive late braking
    const rolling = onRoad ? 0.014 : 0.075

    // weight shifts to the rear under power and to the front under braking
    const shiftLoad = (MASS * this.ax * CG_HEIGHT) / WHEELBASE
    const loadF = Math.max(0, (MASS * G * CG_REAR) / WHEELBASE - shiftLoad)
    const loadR = Math.max(0, (MASS * G * CG_FRONT) / WHEELBASE + shiftLoad)

    // --- engine and gearbox
    const ratio = (this.gear === -1 ? -REVERSE : GEARS[this.gear - 1]) * FINAL
    const wheelRpm = Math.abs((vf / WHEEL_R) * ratio * 9.5493)
    let rpm = Math.max(wheelRpm, IDLE + this.throttle * 1500) // the clutch slips when pulling away
    if (this.shift > 0) this.shift -= h
    else if (this.gear > 0) {
      const next = GEARS[this.gear] && (wheelRpm * GEARS[this.gear]) / GEARS[this.gear - 1]
      const prev = this.gear > 1 && (wheelRpm * GEARS[this.gear - 2]) / GEARS[this.gear - 1]
      if (wheelRpm > 6300 && next) (this.gear++, (this.shift = 0.22))
      else if (prev && prev < 3000 + this.throttle * 2200) (this.gear--, (this.shift = 0.18))
    }
    let torque = 0
    if (this.shift <= 0 && rpm < REDLINE) torque = torqueAt(rpm) * this.throttle * this.power * clamp((TOP_SPEED - speed) / 6, 0, 1) * (this.limp ? 0.7 : 1)
    if (this.throttle < 0.05) torque -= 28 * (rpm / REDLINE) // engine braking
    this.rpm += (Math.min(rpm, REDLINE) - this.rpm) * Math.min(1, h * 14)

    let drive = (torque * ratio * DRIVELINE) / WHEEL_R
    const gripF = mu * loadF
    const gripR = mu * loadR
    const wheelspin = Math.abs(drive) > gripF
    drive = clamp(drive, -gripF, gripF)

    // --- brakes act against the direction of travel
    const dir = vf > 0.05 ? 1 : vf < -0.05 ? -1 : 0
    const brakeF = -dir * this.brake * Math.min(BRAKE_FORCE * 0.66, gripF)
    let brakeR = -dir * this.brake * Math.min(BRAKE_FORCE * 0.34, gripR)
    if (this.handbrake) brakeR = -dir * gripR * 0.9
    const longF = drive + brakeF
    const longR = brakeR

    // --- tyre side forces from the slip angles
    const cs = Math.cos(this.steer)
    const sn = Math.sin(this.steer)
    const latFront = vr + CG_FRONT * w
    const alongWheel = vf * cs + latFront * sn
    const acrossWheel = -vf * sn + latFront * cs
    const alphaF = Math.atan2(acrossWheel, Math.max(Math.abs(alongWheel), 1.5))
    const alphaR = Math.atan2(vr - CG_REAR * w, Math.max(Math.abs(vf), 1.5))
    // a tyre that is already braking or pulling hard has less left for cornering
    const share = (long, grip) => (grip > 0 ? Math.sqrt(Math.max(0.05, 1 - (long / grip) ** 2)) : 0)
    const sideF = -tyre(alphaF) * gripF * share(longF, gripF)
    // a little extra hold at the rear keeps the tail from stepping out unless the handbrake is pulled
    const sideR = -tyre(alphaR) * gripR * share(longR, gripR) * (this.handbrake ? 0.4 : 1.2)

    // --- sum up in the car's frame
    let forceF = longF * cs - sideF * sn + longR
    let forceR = sideF * cs + longF * sn + sideR
    forceF -= DRAG * speed * vf + (speed > 0.1 ? Math.sign(vf) * rolling * MASS * G : 0)
    forceR -= DRAG * speed * vr
    if (!this.airborne) {
      forceF -= MASS * G * Math.sin(this.pitch)
      forceR -= MASS * G * Math.sin(this.roll)
    }
    const turnMoment = CG_FRONT * (sideF * cs + longF * sn) - CG_REAR * sideR

    const ax = forceF / MASS
    const ay = forceR / MASS
    this.ax += (ax - this.ax) * Math.min(1, h * 12)
    this.ay += (ay - this.ay) * Math.min(1, h * 12)
    const vfOld = vf
    vf += ax * h
    vr += ay * h
    let spin = (w + (turnMoment / INERTIA) * h) * (1 - Math.min(1, h * 0.9)) // damped, so it settles quickly after a turn

    // brakes stop the car, they don't push it backwards
    if ((this.brake > 0 || this.handbrake) && vfOld * vf < 0) vf = 0
    // hill hold: with the foot off the gas a nearly stopped car stays put, also on a slope
    if (this.throttle < 0.05 && Math.abs(vf) < 0.5) {
      vf = 0
      vr *= 0.8
    }

    // at walking pace the tyres simply roll where they point
    const sp = Math.hypot(vf, vr)
    if (sp < 4 && !this.airborne) {
      const k = smoothstep(1, 4, sp)
      const rollSpin = (vf * Math.tan(this.steer)) / WHEELBASE
      spin = lerp(rollSpin, spin, k)
      vr = lerp(CG_REAR * rollSpin, vr, k)
    }

    this.spinRate = spin
    this.vx = vf * sin + vr * cos
    this.vz = -vf * cos + vr * sin
    this.yaw += spin * h
    this.x += this.vx * h
    this.z += this.vz * h
    this.wheelSpin += ((wheelspin ? vf + Math.sign(drive) * 6 : vf) * h) / WHEEL_R

    const sliding = Math.max(Math.abs(alphaR), Math.abs(alphaF)) * (sp > 3 ? 1 : 0)
    const locked = this.handbrake && sp > 2 ? 1 : 0
    this.slip = clamp(Math.max((sliding - 0.12) * 4, wheelspin && sp > 1 ? 0.7 : 0, locked), 0, 1)

    this.collide()
  }

  // push the car out of whatever it hit and take the bounce and spin from it
  bounce(px, pz, nx, nz, depth, restitution) {
    this.x += nx * depth
    this.z += nz * depth
    const rx = px - this.x
    const rz = pz - this.z
    const vpx = this.vx - this.spinRate * rz
    const vpz = this.vz + this.spinRate * rx
    const vn = vpx * nx + vpz * nz
    if (vn >= 0) return 0
    const rn = rx * nz - rz * nx
    const j = (-(1 + restitution) * vn) / (1 / MASS + (rn * rn) / INERTIA)
    this.vx += (j * nx) / MASS
    this.vz += (j * nz) / MASS
    this.spinRate += (rn * j) / INERTIA
    // scraping along the obstacle
    const tx = -nz
    const tz = nx
    const vt = vpx * tx + vpz * tz
    const rt = rx * tz - rz * tx
    const jt = clamp(-vt / (1 / MASS + (rt * rt) / INERTIA), -0.35 * j, 0.35 * j)
    this.vx += (jt * tx) / MASS
    this.vz += (jt * tz) / MASS
    this.spinRate += (rt * jt) / INERTIA
    if (-vn > this.impact) {
      this.impact = -vn
      this.hit = { x: px, z: pz, v: -vn }
    }
    return -vn
  }

  collide() {
    const { terrain, buildings, trunksNear, obstacles, solids = [] } = this.world
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)

    // house walls and the edge of the map
    for (const [f, r] of HULL) {
      const px = this.x + sin * f + cos * r
      const pz = this.z - cos * f + sin * r
      const lim = terrain.half - 14
      if (Math.abs(px) > lim) this.bounce(px, pz, -Math.sign(px), 0, Math.abs(px) - lim, 0.1)
      if (Math.abs(pz) > lim) this.bounce(px, pz, 0, -Math.sign(pz), Math.abs(pz) - lim, 0.1)
      // pushes the car back out of a closed outline (a house, the raised pitch)
      const wall = (fp) => {
        if (!inRing(fp, px, pz)) return false
        // nearest wall of that house
        let best = Infinity
        let qx = 0
        let qz = 0
        for (let a = 0, n = fp.length; a < n; a += 2) {
          const b = (a + 2) % n
          const ex = fp[b] - fp[a]
          const ez = fp[b + 1] - fp[a + 1]
          const t = clamp(((px - fp[a]) * ex + (pz - fp[a + 1]) * ez) / (ex * ex + ez * ez || 1), 0, 1)
          const cx = fp[a] + ex * t
          const cz = fp[a + 1] + ez * t
          const d = (cx - px) ** 2 + (cz - pz) ** 2
          if (d < best) {
            best = d
            qx = cx
            qz = cz
          }
        }
        const d = Math.sqrt(best)
        if (d > 1e-4 && d < 6) this.bounce(px, pz, (qx - px) / d, (qz - pz) / d, d, 0.12)
        return true
      }
      buildings.nearby(px, pz, (i) => wall(buildings.footprints[i]))
      for (const fp of solids) wall(fp)
    }

    // tree trunks and other vehicles
    for (const [f, radius] of BUMPERS) {
      const cx = this.x + sin * f
      const cz = this.z - cos * f
      const test = (ox, oz, or, onHit) => {
        const dx = cx - ox
        const dz = cz - oz
        const d = Math.hypot(dx, dz)
        if (d >= radius + or || d < 1e-4) return
        const nx = dx / d
        const nz = dz / d
        const hit = this.bounce(ox + nx * or, oz + nz * or, nx, nz, radius + or - d, 0.15)
        onHit?.(hit)
      }
      trunksNear(cx, cz, (tx, tz, tr) => test(tx, tz, tr))
      for (const o of obstacles) test(o.x, o.z, o.r, o.hit)
    }
  }

  groundPose() {
    const t = this.world.terrain
    const sin = Math.sin(this.yaw)
    const cos = Math.cos(this.yaw)
    const h = (f, r) => t.heightAt(this.x + sin * f + cos * r, this.z - cos * f + sin * r)
    const a = WHEELBASE / 2
    const fl = h(a, -TRACK / 2)
    const fr = h(a, TRACK / 2)
    const rl = h(-a, -TRACK / 2)
    const rr = h(-a, TRACK / 2)
    return {
      y: (fl + fr + rl + rr) / 4 + 0.16, // roads lie a little above the terrain
      pitch: Math.atan2((fl + fr - rl - rr) / 2, WHEELBASE),
      roll: Math.atan2((fr + rr - fl - rl) / 2, TRACK),
    }
  }

  // follow the ground, leave it over crests, and let the body lean on its springs
  sit(dt) {
    const g = this.groundPose()
    if (!this.airborne) {
      // the wheels follow the road unless it drops away faster than the car can fall
      const follow = (g.y - this.y) / dt
      if (follow < this.vy - G * dt - 1.6) this.airborne = true
      else {
        this.vy = clamp(follow, -30, 30)
        this.y = g.y
      }
    }
    if (this.airborne) {
      this.vy -= G * dt
      this.y += this.vy * dt
      if (this.y <= g.y) {
        if (this.vy < -3) this.impact = Math.max(this.impact, -this.vy * 0.5)
        this.y = g.y
        this.vy = 0
        this.airborne = false
      }
    }
    const k = this.airborne ? 0 : 1 - Math.exp(-dt * 10)
    this.pitch += (g.pitch - this.pitch) * k
    this.roll += (g.roll - this.roll) * k
    const s = 1 - Math.exp(-dt * 7)
    this.lean += (clamp(this.ay * 0.0065, -0.075, 0.075) - this.lean) * s
    this.dive += (clamp(this.ax * 0.005, -0.05, 0.05) - this.dive) * s
  }
}
