import * as THREE from 'three'
import { canvasTexture } from './textures.js'
import { clamp } from './util.js'

// Crash damage for the player's car: every hit adds damage and dents the
// bodywork where it landed, harder hits knock parts off, and from about a
// third damage the engine smokes. At 100 % the engine dies.

const SMOKE = 40 // sprites in the pool

export class Damage {
  constructor(scene, terrain) {
    this.scene = scene
    this.terrain = terrain
    this.level = 0 // 0..100
    this.cooldown = 0
    this.debris = []
    this.emit = 0

    const tex = canvasTexture(64, 64, (c, w) => {
      const g = c.createRadialGradient(w / 2, w / 2, 2, w / 2, w / 2, w / 2)
      g.addColorStop(0, 'rgba(255,255,255,0.9)')
      g.addColorStop(0.5, 'rgba(255,255,255,0.35)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      c.fillStyle = g
      c.fillRect(0, 0, w, w)
    })
    this.puffs = []
    for (let i = 0; i < SMOKE; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }))
      sprite.visible = false
      sprite.renderOrder = 30
      scene.add(sprite)
      this.puffs.push({ sprite, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 1 })
    }
  }

  // start over with a fresh car model
  reset(mesh) {
    this.mesh = mesh
    this.level = 0
    this.cooldown = 0
    for (const d of this.debris) this.scene.remove(d.mesh)
    this.debris.length = 0
    for (const p of this.puffs) {
      p.life = 0
      p.sprite.visible = false
    }
  }

  // Registers a crash. car: the Vehicle, with car.hit = { x, z, v } set by the
  // physics. Returns the damage added (0 while a previous crash is still settling).
  crash(car) {
    const hit = car.hit
    if (!hit || hit.v < 3 || this.cooldown > 0 || this.level >= 100) return 0
    this.cooldown = 0.6
    const added = clamp((hit.v - 2.5) * 2.4, 2, 34)
    this.level = Math.min(100, this.level + added)

    // where the hit landed, in the car's own frame (x right, z back)
    const sin = Math.sin(car.yaw)
    const cos = Math.cos(car.yaw)
    const dx = hit.x - car.x
    const dz = hit.z - car.z
    const lx = dx * cos + dz * sin
    const lz = -(dx * sin - dz * cos)
    this.dent(lx, lz, hit.v)
    if (hit.v > 5) this.shed(lx, lz, car)
    return added
  }

  // push the bodywork in around the point of impact
  dent(lx, lz, speed) {
    const body = this.mesh.userData.body
    const reach = 1.0
    const depth = Math.min(0.32, speed * 0.02)
    const len = Math.hypot(lx, lz) || 1
    const inX = -lx / len
    const inZ = -lz / len
    for (const part of body.children) {
      if (!part.isMesh || part.userData.loose) continue
      const pos = part.geometry.attributes.position
      let touched = false
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i)
        const z = pos.getZ(i)
        const d = Math.hypot(x - lx, z - lz)
        if (d >= reach) continue
        const f = (1 - d / reach) ** 2
        // uneven, so the metal looks crumpled and not neatly pressed
        const rough = 0.55 + 0.9 * Math.abs(Math.sin(x * 37.1 + z * 53.7 + pos.getY(i) * 71.3))
        const a = depth * f * rough
        pos.setXYZ(i, x + inX * a, pos.getY(i) - a * 0.18 * rough, z + inZ * a)
        touched = true
      }
      if (touched) {
        pos.needsUpdate = true
        part.geometry.computeVertexNormals()
      }
    }
  }

  // knock off the loose part closest to the impact
  shed(lx, lz, car) {
    const loose = this.mesh.userData.loose
    let best = -1
    let bd = 1.7
    loose.forEach((part, i) => {
      const d = Math.hypot(part.position.x - lx, part.position.z - lz)
      if (d < bd) {
        bd = d
        best = i
      }
    })
    if (best < 0 && loose.length && Math.random() < 0.35) best = (Math.random() * loose.length) | 0
    if (best < 0) return
    const [part] = loose.splice(best, 1)
    this.scene.attach(part) // keeps its place in the world
    part.castShadow = true
    this.debris.push({
      mesh: part,
      vx: car.vx * 0.6 + (Math.random() - 0.5) * 4,
      vy: 2 + Math.random() * 3,
      vz: car.vz * 0.6 + (Math.random() - 0.5) * 4,
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(14),
      life: 30,
    })
  }

  update(dt, car) {
    this.cooldown -= dt

    // parts tumbling down the road
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]
      const p = d.mesh.position
      d.vy -= 9.81 * dt
      p.x += d.vx * dt
      p.y += d.vy * dt
      p.z += d.vz * dt
      const floor = this.terrain.heightAt(p.x, p.z) + 0.22
      if (p.y < floor) {
        p.y = floor
        d.vy = Math.abs(d.vy) > 1 ? -d.vy * 0.35 : 0
        d.vx *= 0.7
        d.vz *= 0.7
        d.spin.multiplyScalar(0.6)
      }
      d.mesh.rotation.x += d.spin.x * dt
      d.mesh.rotation.y += d.spin.y * dt
      d.mesh.rotation.z += d.spin.z * dt
      d.life -= dt
      if (d.life <= 0) {
        this.scene.remove(d.mesh)
        this.debris.splice(i, 1)
      }
    }

    // tyre smoke while the wheels spin or the car slides
    this.burn = (this.burn ?? 0) + (car.slip > 0.6 && car.speed > 2 ? 22 : 0) * dt
    while (this.burn >= 1) {
      this.burn -= 1
      const p = this.puffs.find((k) => k.life <= 0)
      if (!p) break
      const side = Math.random() < 0.5 ? -0.7 : 0.7
      const back = car.forwardSpeed > 4 && !car.handbrake ? -1.3 : 1.3 // front wheels when they spin under power
      p.max = p.life = 0.9 + Math.random() * 0.7
      p.grow = 1.4 + Math.random()
      p.vx = car.vx * 0.3 + (Math.random() - 0.5)
      p.vy = 0.5 + Math.random() * 0.6
      p.vz = car.vz * 0.3 + (Math.random() - 0.5)
      p.sprite.material.color.setRGB(0.86, 0.86, 0.86)
      p.sprite.position.set(car.x - Math.sin(car.yaw) * back + Math.cos(car.yaw) * side, car.y + 0.2, car.z + Math.cos(car.yaw) * back + Math.sin(car.yaw) * side)
      p.sprite.visible = true
    }

    // smoke from under the bonnet: thin and pale at first, thick and black at the end
    const lv = this.level
    const rate = lv < 35 ? 0 : lv < 70 ? 7 : lv < 100 ? 16 : 26
    const dark = lv < 70 ? 0.7 : lv < 100 ? 0.32 : 0.08
    this.emit += rate * dt
    const sin = Math.sin(car.yaw)
    const cos = Math.cos(car.yaw)
    for (const p of this.puffs) {
      if (p.life > 0) {
        p.life -= dt
        const s = p.sprite
        s.position.x += p.vx * dt
        s.position.y += p.vy * dt
        s.position.z += p.vz * dt
        const t = 1 - p.life / p.max
        s.scale.setScalar((0.5 + t * p.grow) * 1.4)
        s.material.opacity = Math.sin(Math.min(1, t * 4) * Math.PI * 0.5) * (1 - t) * 0.6
        if (p.life <= 0) s.visible = false
      } else if (this.emit >= 1) {
        this.emit -= 1
        p.max = p.life = 1.5 + Math.random() * 1.3
        p.grow = 1.6 + Math.random() * 1.6
        p.vx = car.vx * 0.25 + (Math.random() - 0.5) * 0.8 + 0.6
        p.vy = 1.3 + Math.random() * 1.2
        p.vz = car.vz * 0.25 + (Math.random() - 0.5) * 0.8
        const k = dark * (0.8 + Math.random() * 0.4)
        p.sprite.material.color.setRGB(k, k, k)
        p.sprite.position.set(car.x + sin * 1.5 + cos * (Math.random() - 0.5) * 0.8, car.y + 0.8, car.z - cos * 1.5 + sin * (Math.random() - 0.5) * 0.8)
        p.sprite.visible = true
      }
    }
  }
}
