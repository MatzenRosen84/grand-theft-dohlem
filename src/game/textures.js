import * as THREE from 'three'
import { rng } from './util.js'

export function canvasTexture(w, h, draw, { aniso = 8 } = {}) {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  draw(cv.getContext('2d'), w, h)
  const tex = new THREE.CanvasTexture(cv)
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = aniso
  return tex
}

// Normal map from the brightness of a texture: bright stands proud, dark is recessed.
export function normalFrom(tex, strength = 2) {
  const src = tex.image
  const w = src.width
  const h = src.height
  const data = src.getContext('2d').getImageData(0, 0, w, h).data
  const lum = (x, y) => {
    const i = (((y + h) % h) * w + ((x + w) % w)) * 4
    return (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) / 255
  }
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  const out = ctx.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (lum(x + 1, y) - lum(x - 1, y)) * strength
      const dy = (lum(x, y + 1) - lum(x, y - 1)) * strength
      const len = Math.hypot(dx, dy, 1)
      const i = (y * w + x) * 4
      out.data[i] = (-dx / len) * 127 + 128
      out.data[i + 1] = (dy / len) * 127 + 128
      out.data[i + 2] = (1 / len) * 127 + 128
      out.data[i + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  const n = new THREE.CanvasTexture(cv)
  n.wrapS = n.wrapT = THREE.RepeatWrapping
  n.anisotropy = tex.anisotropy
  return n
}

// random light/dark speckles over whatever is already drawn
function speckle(ctx, w, h, amount, seed = 1, size = 1, strength = 1) {
  const r = rng(seed)
  for (let i = 0; i < (w * h * amount) / (size * size); i++) {
    const v = r()
    ctx.fillStyle = v < 0.5 ? `rgba(0,0,0,${(0.05 + v * 0.25) * strength})` : `rgba(255,255,255,${(v - 0.5) * 0.25 * strength})`
    ctx.fillRect(r() * w, r() * h, size + r() * size, size + r() * size)
  }
}

export function noiseCanvas(size = 256, seed = 7) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(size, size)
  const r = rng(seed)
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 90 + r() * 75
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v
    img.data[i + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return cv
}

// soft cloudy noise: several layers of blurred static, coarse to fine
export function cloudCanvas(size = 512, seed = 3) {
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const ctx = cv.getContext('2d')
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, size, size)
  ctx.imageSmoothingQuality = 'high'
  let alpha = 0.6
  for (const cells of [4, 8, 16, 32, 64, 128]) {
    const n = noiseCanvas(cells, seed + cells)
    ctx.globalAlpha = alpha
    // drawn 3x3 so the result tiles
    for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) ctx.drawImage(n, x * size, y * size, size, size)
    alpha *= 0.62
  }
  ctx.globalAlpha = 1
  return cv
}

export function detailTexture() {
  const tex = new THREE.CanvasTexture(cloudCanvas(512, 21))
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping
  tex.anisotropy = 8
  return tex
}

// --- roads (u runs across the road, v along it) -------------------------

function asphalt(c, w, h, base, seed) {
  c.fillStyle = base
  c.fillRect(0, 0, w, h)
  speckle(c, w, h, 0.5, seed, 1, 0.5)
  speckle(c, w, h, 0.02, seed + 1, 3, 0.5)
  // patches and tar seams
  const r = rng(seed + 2)
  for (let i = 0; i < 5; i++) {
    c.fillStyle = `rgba(${r() < 0.5 ? '20,20,22' : '110,110,112'},${0.08 + r() * 0.1})`
    c.fillRect(r() * w, r() * h, w * (0.1 + r() * 0.3), h * (0.05 + r() * 0.2))
  }
  c.strokeStyle = 'rgba(15,15,16,0.5)'
  c.lineWidth = 1.5
  for (let i = 0; i < 4; i++) {
    c.beginPath()
    let x = r() * w
    let y = r() * h
    c.moveTo(x, y)
    for (let k = 0; k < 6; k++) c.lineTo((x += (r() - 0.5) * 40), (y += r() * 40))
    c.stroke()
  }
  // darker lanes where the tyres run
  for (const lane of [0.27, 0.73]) {
    const g = c.createLinearGradient(w * (lane - 0.1), 0, w * (lane + 0.1), 0)
    g.addColorStop(0, 'rgba(10,10,12,0)')
    g.addColorStop(0.5, 'rgba(10,10,12,0.3)')
    g.addColorStop(1, 'rgba(10,10,12,0)')
    c.fillStyle = g
    c.fillRect(w * (lane - 0.1), 0, w * 0.2, h)
  }
}

export const roadTextures = {
  asphalt: () =>
    canvasTexture(512, 512, (c, w, h) => {
      asphalt(c, w, h, '#424346', 3)
      const g = c.createLinearGradient(0, 0, w, 0)
      g.addColorStop(0, 'rgba(150,140,120,0.5)')
      g.addColorStop(0.09, 'rgba(150,140,120,0)')
      g.addColorStop(0.91, 'rgba(150,140,120,0)')
      g.addColorStop(1, 'rgba(150,140,120,0.5)')
      c.fillStyle = g
      c.fillRect(0, 0, w, h)
    }),

  // country road: dashed centre line (4 m line, 8 m gap), solid edge lines
  major: () =>
    canvasTexture(512, 1024, (c, w, h) => {
      asphalt(c, w, h, '#3a3b3e', 5)
      c.fillStyle = 'rgba(232,232,222,0.92)'
      c.fillRect(w * 0.035, 0, w * 0.018, h)
      c.fillRect(w * (1 - 0.053), 0, w * 0.018, h)
      c.fillRect(w / 2 - w * 0.009, 0, w * 0.018, h / 3)
      speckle(c, w, h, 0.12, 9, 1, 0.6)
    }),

  // farm track: two gravel ruts, grass in between
  track: () =>
    canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#8f8669'
      c.fillRect(0, 0, w, h)
      speckle(c, w, h, 0.6, 11, 2)
      const g = c.createLinearGradient(0, 0, w, 0)
      g.addColorStop(0, 'rgba(98,122,58,0.95)')
      g.addColorStop(0.14, 'rgba(98,122,58,0)')
      g.addColorStop(0.4, 'rgba(98,122,58,0)')
      g.addColorStop(0.5, 'rgba(98,122,58,0.9)')
      g.addColorStop(0.6, 'rgba(98,122,58,0)')
      g.addColorStop(0.86, 'rgba(98,122,58,0)')
      g.addColorStop(1, 'rgba(98,122,58,0.95)')
      c.fillStyle = g
      c.fillRect(0, 0, w, h)
      speckle(c, w, h, 0.2, 12, 1, 0.6)
    }),

  path: () =>
    canvasTexture(128, 128, (c, w, h) => {
      c.fillStyle = '#9c8f74'
      c.fillRect(0, 0, w, h)
      speckle(c, w, h, 0.6, 13, 2)
    }),

  sidewalk: () =>
    canvasTexture(512, 128, (c, w, h) => {
      c.fillStyle = '#9d9a94'
      c.fillRect(0, 0, w, h)
      speckle(c, w, h, 0.3, 15, 1, 0.5)
      // paving stones, kerbstones along both edges
      c.fillStyle = 'rgba(50,50,50,0.3)'
      for (let y = 0; y < h; y += h / 4) c.fillRect(0, y, w, 1.5)
      for (let x = 0; x < w; x += w / 16) c.fillRect(x, 0, 1.5, h)
      c.fillStyle = '#bdbab2'
      c.fillRect(0, 0, 12, h)
      c.fillRect(w - 12, 0, 12, h)
      c.fillStyle = 'rgba(40,40,40,0.45)'
      c.fillRect(12, 0, 2, h)
      c.fillRect(w - 14, 0, 2, h)
      // weeds in the joints and along the kerb, dirt in the gutter
      const r = rng(16)
      for (let i = 0; i < 70; i++) {
        const edge = r() < 0.6
        const x = edge ? (r() < 0.5 ? 12 + r() * 10 : w - 22 + r() * 10) : Math.round(r() * 16) * (w / 16)
        c.fillStyle = `rgba(${70 + r() * 40},${110 + r() * 50},${40 + r() * 20},${0.5 + r() * 0.4})`
        c.fillRect(x - 2, r() * h, 3 + r() * 4, 2 + r() * 4)
      }
      c.fillStyle = 'rgba(40,38,34,0.25)'
      c.fillRect(0, 0, 4, h)
      c.fillRect(w - 4, 0, 4, h)
    }),

  rail: () =>
    canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#5d564c'
      c.fillRect(0, 0, w, h)
      speckle(c, w, h, 0.7, 17, 2)
      c.fillStyle = '#3b3027'
      for (let i = 0; i < 4; i++) c.fillRect(w * 0.14, i * (h / 4) + 12, w * 0.72, h / 10)
      c.fillStyle = '#9a9da3'
      c.fillRect(w * 0.29, 0, 7, h)
      c.fillRect(w * 0.71 - 7, 0, 7, h)
    }),

  water: () =>
    canvasTexture(64, 64, (c, w, h) => {
      c.fillStyle = '#3f6d86'
      c.fillRect(0, 0, w, h)
      speckle(c, w, h, 0.3, 19, 3)
    }),
}

// --- buildings -----------------------------------------------------------
// Wall tiles are 3.2 m wide and one storey (2.9 m) high, with one window each.
// They are drawn in white and tinted per house.

const TILE = 256

function plaster(c, seed) {
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, TILE, TILE)
  speckle(c, TILE, TILE, 0.3, seed, 1, 0.3)
  const r = rng(seed + 5)
  for (let i = 0; i < 10; i++) {
    c.fillStyle = `rgba(90,85,75,${0.02 + r() * 0.035})`
    c.fillRect(r() * TILE, 0, 2 + r() * 5, TILE * (0.3 + r() * 0.7))
  }
  for (let i = 0; i < 5; i++) {
    const x = r() * TILE
    const y = r() * TILE
    const size = 14 + r() * 34
    const g = c.createRadialGradient(x, y, 2, x, y, size)
    g.addColorStop(0, `rgba(70,72,66,${0.1 + r() * 0.1})`)
    g.addColorStop(1, 'rgba(70,72,66,0)')
    c.fillStyle = g
    c.fillRect(x - size, y - size, size * 2, size * 2)
  }
  const grime = c.createLinearGradient(0, TILE * 0.72, 0, TILE)
  grime.addColorStop(0, 'rgba(60,62,56,0)')
  grime.addColorStop(1, 'rgba(60,62,56,0.16)')
  c.fillStyle = grime
  c.fillRect(0, 0, TILE, TILE)
}

function windowPane(c, x, y, w, h, frame = '#f3f1ec') {
  c.fillStyle = 'rgba(0,0,0,0.25)'
  c.fillRect(x - 3, y - 3, w + 6, h + 8)
  c.fillStyle = frame
  c.fillRect(x, y, w, h)
  const g = c.createLinearGradient(0, y, 0, y + h)
  g.addColorStop(0, '#26323e')
  g.addColorStop(0.55, '#4d6274')
  g.addColorStop(1, '#3a4a58')
  c.fillStyle = g
  c.fillRect(x + 5, y + 5, w - 10, h - 10)
  // curtain and reflection
  c.fillStyle = 'rgba(235,232,222,0.5)'
  c.fillRect(x + 5, y + 5, (w - 10) * 0.22, h - 10)
  c.fillRect(x + w - 5 - (w - 10) * 0.22, y + 5, (w - 10) * 0.22, h - 10)
  c.fillStyle = 'rgba(255,255,255,0.1)'
  c.beginPath()
  c.moveTo(x + 5, y + h * 0.6)
  c.lineTo(x + w - 5, y + h * 0.2)
  c.lineTo(x + w - 5, y + h * 0.4)
  c.lineTo(x + 5, y + h * 0.8)
  c.fill()
  c.fillStyle = frame
  c.fillRect(x + w / 2 - 2.5, y, 5, h)
  // sill
  c.fillStyle = '#8f8b84'
  c.fillRect(x - 8, y + h + 2, w + 16, 7)
}

const WX = TILE * 0.31
const WY = TILE * 0.2
const WW = TILE * 0.38
const WH = TILE * 0.47

export const wallTextures = {
  plain: () => canvasTexture(TILE, TILE, (c) => plaster(c, 29)),

  window: () =>
    canvasTexture(TILE, TILE, (c) => {
      plaster(c, 23)
      // painted surround, common on rendered houses here
      c.fillStyle = 'rgba(120,118,112,0.35)'
      c.fillRect(WX - 9, WY - 9, WW + 18, WH + 20)
      windowPane(c, WX, WY, WW, WH)
      const streak = c.createLinearGradient(0, WY + WH + 9, 0, TILE)
      streak.addColorStop(0, 'rgba(58,60,56,0.26)')
      streak.addColorStop(1, 'rgba(58,60,56,0)')
      c.fillStyle = streak
      for (const x of [WX - 6, WX + WW * 0.28, WX + WW * 0.6, WX + WW]) c.fillRect(x, WY + WH + 9, 5, TILE * 0.3)
    }),

  // window with a roller-shutter box and folding shutters
  shutter: () =>
    canvasTexture(TILE, TILE, (c) => {
      plaster(c, 41)
      windowPane(c, WX, WY, WW, WH)
      for (const x of [WX - 34, WX + WW + 4]) {
        c.fillStyle = '#4d5a4a'
        c.fillRect(x, WY - 2, 30, WH + 4)
        c.fillStyle = 'rgba(0,0,0,0.3)'
        for (let y = WY + 2; y < WY + WH; y += 7) c.fillRect(x + 3, y, 24, 2)
      }
    }),

  // half-timbered: oak frame, limewashed panels
  fachwerk: () =>
    canvasTexture(TILE, TILE, (c) => {
      c.fillStyle = '#f3efe4'
      c.fillRect(0, 0, TILE, TILE)
      speckle(c, TILE, TILE, 0.3, 43, 1, 0.3)
      windowPane(c, WX + 8, WY + 6, WW - 16, WH - 12)
      const beam = (x0, y0, x1, y1, t) => {
        c.strokeStyle = '#3d2b1e'
        c.lineWidth = t
        c.beginPath()
        c.moveTo(x0, y0)
        c.lineTo(x1, y1)
        c.stroke()
        c.strokeStyle = 'rgba(110,80,50,0.35)'
        c.lineWidth = 1
        c.beginPath()
        c.moveTo(x0 + 2, y0 + 2)
        c.lineTo(x1 + 2, y1 + 2)
        c.stroke()
      }
      const t = 15
      beam(0, t / 2, TILE, t / 2, t) // head beam
      beam(0, TILE - t / 2, TILE, TILE - t / 2, t) // sill beam
      beam(0, 0, 0, TILE, t * 2) // posts (halves meet across tiles)
      beam(TILE, 0, TILE, TILE, t * 2)
      beam(WX - 4, 0, WX - 4, TILE, t)
      beam(WX + WW + 4, 0, WX + WW + 4, TILE, t)
      beam(WX, WY - 4, WX + WW, WY - 4, t - 3)
      beam(WX, WY + WH + 2, WX + WW, WY + WH + 2, t - 3)
      beam(t, TILE - t, WX - 10, t + 4, t - 3) // braces
      beam(TILE - t, TILE - t, WX + WW + 10, t + 4, t - 3)
    }),

  // slate hung on the weather side, typical for the Westerwald
  slate: () =>
    canvasTexture(TILE, TILE, (c) => {
      slateScales(c, TILE, TILE, 16, 12, 47)
      windowPane(c, WX, WY, WW, WH)
    }),

  // basalt plinth
  stone: () =>
    canvasTexture(TILE, TILE, (c) => {
      c.fillStyle = '#77777a'
      c.fillRect(0, 0, TILE, TILE)
      const r = rng(53)
      const rows = 6
      for (let j = 0; j < rows; j++) {
        let x = -r() * 40
        while (x < TILE) {
          const w = 30 + r() * 50
          const v = 125 + r() * 70
          c.fillStyle = `rgb(${v},${v},${v + 4})`
          c.fillRect(x + 2, j * (TILE / rows) + 2, w - 4, TILE / rows - 4)
          x += w
        }
      }
      speckle(c, TILE, TILE, 0.4, 54, 1, 0.6)
    }),

  door: () => {
    const t = canvasTexture(128, 256, (c, w, h) => {
      c.fillStyle = '#e9e6df'
      c.fillRect(0, 0, w, h)
      c.fillStyle = '#ffffff'
      c.fillRect(8, 8, w - 16, h - 8)
      c.fillStyle = 'rgba(0,0,0,0.22)'
      c.fillRect(8, 8, w - 16, 3)
      c.strokeStyle = 'rgba(0,0,0,0.3)'
      c.lineWidth = 3
      c.strokeRect(22, 120, w - 44, h - 140)
      const g = c.createLinearGradient(0, 24, 0, 100)
      g.addColorStop(0, '#2b3945')
      g.addColorStop(1, '#55697a')
      c.fillStyle = g
      c.fillRect(22, 24, w - 44, 80)
      c.fillStyle = '#c9c3a8'
      c.fillRect(w - 30, 138, 8, 22)
    })
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
    return t
  },
}

function slateScales(c, w, h, cols, rows, seed) {
  c.fillStyle = '#3c4148'
  c.fillRect(0, 0, w, h)
  const r = rng(seed)
  const cw = w / cols
  const rh = h / rows
  for (let j = -1; j < rows; j++) {
    for (let i = -1; i <= cols; i++) {
      const v = 150 + r() * 80
      const x = (i + (j & 1) * 0.5) * cw
      const y = j * rh
      c.fillStyle = `rgb(${v},${v},${v + 6})`
      c.beginPath()
      c.moveTo(x, y)
      c.lineTo(x + cw, y)
      c.lineTo(x + cw, y + rh * 0.9)
      c.arc(x + cw / 2, y + rh * 0.9, cw / 2, 0, Math.PI)
      c.closePath()
      c.fill()
      c.strokeStyle = 'rgba(0,0,0,0.5)'
      c.lineWidth = 1.2
      c.stroke()
    }
  }
}

// Roofs: u along the ridge, v down the slope, 1.2 m per repeat. White, tinted per house.
export const roofTextures = {
  slate: () => canvasTexture(256, 256, (c, w, h) => slateScales(c, w, h, 6, 6, 61)),
  tile: () =>
    canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#ffffff'
      c.fillRect(0, 0, w, h)
      const rows = 4
      const cols = 6
      const r = rng(37)
      for (let j = 0; j < rows; j++) {
        for (let i = -1; i < cols; i++) {
          const v = 195 + r() * 60
          const x = (i + (j % 2) * 0.5) * (w / cols)
          // each pantile: bright crown, dark gutter
          const g = c.createLinearGradient(x, 0, x + w / cols, 0)
          g.addColorStop(0, `rgb(${v * 0.55},${v * 0.55},${v * 0.55})`)
          g.addColorStop(0.45, `rgb(${v},${v},${v})`)
          g.addColorStop(1, `rgb(${v * 0.7},${v * 0.7},${v * 0.7})`)
          c.fillStyle = g
          c.fillRect(x, j * (h / rows), w / cols, h / rows)
        }
        const g = c.createLinearGradient(0, j * (h / rows), 0, (j + 1) * (h / rows))
        g.addColorStop(0, 'rgba(0,0,0,0.5)')
        g.addColorStop(0.25, 'rgba(0,0,0,0)')
        c.fillStyle = g
        c.fillRect(0, j * (h / rows), w, h / rows)
      }
    }),
}
