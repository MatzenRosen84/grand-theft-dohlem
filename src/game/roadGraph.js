// The drivable road network as a graph: junctions and bends are nodes, the
// stretches between them edges. Used for GPS routes, traffic, pedestrians and
// for choosing where customers wait.

// v: usual speed in m/s, w: road width in metres
const KINDS = {
  primary: { v: 25, w: 7.5 },
  secondary: { v: 22, w: 7 },
  tertiary: { v: 19, w: 6.2 },
  unclassified: { v: 14, w: 5 },
  residential: { v: 8.5, w: 5.5 },
  living_street: { v: 4, w: 4.6 },
  service: { v: 4, w: 3.4, minor: true },
}

class Heap {
  constructor() {
    this.items = []
  }
  push(key, value) {
    const a = this.items
    a.push([key, value])
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p][0] <= a[i][0]) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop() {
    const a = this.items
    const top = a[0]
    const last = a.pop()
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l][0] < a[m][0]) m = l
        if (r < a.length && a[r][0] < a[m][0]) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
  get size() {
    return this.items.length
  }
}

export class RoadGraph {
  // inTown(x, z): true between houses
  constructor(map, terrain, inTown) {
    this.nodes = []
    this.edges = []
    const ids = new Map()
    const node = (x, z) => {
      const key = x + ',' + z
      let id = ids.get(key)
      if (id === undefined) {
        id = this.nodes.length
        ids.set(key, id)
        this.nodes.push({ x, z, edges: [] })
      }
      return id
    }

    for (const road of map.roads) {
      const kind = KINDS[road.k]
      if (!kind) continue
      const p = road.p
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (!terrain.contains(p[i], p[i + 1], 25) || !terrain.contains(p[i + 2], p[i + 3], 25)) continue
        const a = node(p[i], p[i + 1])
        const b = node(p[i + 2], p[i + 3])
        const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1])
        if (a === b || len < 0.01) continue
        const town = inTown((p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2)
        let v = road.max ? Math.min(road.max / 3.6, 28) : kind.v
        if (town) v = Math.min(v, 13.9) // 50 km/h between houses
        const e = { a, b, len, v, w: kind.w, minor: !!kind.minor, town, name: road.n ?? road.ref ?? '' }
        const idx = this.edges.length
        this.edges.push(e)
        this.nodes[a].edges.push(idx)
        this.nodes[b].edges.push(idx)
      }
    }

    // keep to the largest connected piece, so every trip can be driven
    const comp = new Int32Array(this.nodes.length).fill(-1)
    let best = -1
    let bestSize = 0
    for (let s = 0, c = 0; s < this.nodes.length; s++) {
      if (comp[s] !== -1) continue
      const stack = [s]
      comp[s] = c
      let size = 0
      while (stack.length) {
        const n = stack.pop()
        size++
        for (const ei of this.nodes[n].edges) {
          const e = this.edges[ei]
          const o = e.a === n ? e.b : e.a
          if (comp[o] === -1) {
            comp[o] = c
            stack.push(o)
          }
        }
      }
      if (size > bestSize) {
        bestSize = size
        best = c
      }
      c++
    }
    for (const e of this.edges) e.main = comp[e.a] === best

    // streets where people live: candidates for pick-ups, drop-offs and strolling
    this.streets = []
    this.streetLen = 0
    this.edges.forEach((e, i) => {
      if (e.main && e.town && !e.minor && e.len > 6) {
        this.streets.push(i)
        this.streetLen += e.len
      }
    })
  }

  other(edge, nodeId) {
    return edge.a === nodeId ? edge.b : edge.a
  }

  // closest point on the network: { edge, t (0 at a, 1 at b), x, z, dist }
  nearest(x, z, mainOnly = true) {
    let best = null
    let bd = Infinity
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i]
      if (mainOnly && !e.main) continue
      const a = this.nodes[e.a]
      const b = this.nodes[e.b]
      const dx = b.x - a.x
      const dz = b.z - a.z
      let t = ((x - a.x) * dx + (z - a.z) * dz) / (e.len * e.len)
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const px = a.x + dx * t
      const pz = a.z + dz * t
      const d = (px - x) ** 2 + (pz - z) ** 2
      if (d < bd) {
        bd = d
        best = { edge: i, t, x: px, z: pz }
      }
    }
    if (best) best.dist = Math.sqrt(bd)
    return best
  }

  // point on an edge, pushed `side` metres to the right of the a->b direction
  point(edgeIdx, t, side = 0) {
    const e = this.edges[edgeIdx]
    const a = this.nodes[e.a]
    const b = this.nodes[e.b]
    const dx = (b.x - a.x) / e.len
    const dz = (b.z - a.z) / e.len
    return { x: a.x + (b.x - a.x) * t - dz * side, z: a.z + (b.z - a.z) * t + dx * side, dx, dz }
  }

  // random place at the kerb of a village street
  randomSpot(rand) {
    let pick = rand() * this.streetLen
    let idx = this.streets[0]
    for (const i of this.streets) {
      pick -= this.edges[i].len
      if (pick <= 0) {
        idx = i
        break
      }
    }
    const e = this.edges[idx]
    const t = 0.15 + rand() * 0.7
    const side = (rand() < 0.5 ? -1 : 1) * (e.w / 2 + 1.1)
    const kerb = this.point(idx, t, side)
    const road = this.point(idx, t)
    return { edge: idx, t, x: kerb.x, z: kerb.z, roadX: road.x, roadZ: road.z, street: e.name }
  }

  // Shortest drive between two places (by travel time).
  // Returns { pts: [x, z, ...], len } or null.
  route(from, to) {
    const s = this.nearest(from.x, from.z)
    const g = this.nearest(to.x, to.z)
    if (!s || !g) return null
    const se = this.edges[s.edge]
    const ge = this.edges[g.edge]
    if (s.edge === g.edge) return { pts: [s.x, s.z, g.x, g.z], len: Math.abs(s.t - g.t) * se.len }

    const cost = new Float64Array(this.nodes.length).fill(Infinity)
    const prev = new Int32Array(this.nodes.length).fill(-1)
    const heap = new Heap()
    const seed = (n, metres) => {
      cost[n] = metres / se.v
      heap.push(cost[n], n)
    }
    seed(se.a, s.t * se.len)
    seed(se.b, (1 - s.t) * se.len)
    const done = new Uint8Array(this.nodes.length)
    while (heap.size) {
      const [c, n] = heap.pop()
      if (done[n]) continue
      done[n] = 1
      if (done[ge.a] && done[ge.b]) break
      for (const ei of this.nodes[n].edges) {
        const e = this.edges[ei]
        const o = e.a === n ? e.b : e.a
        const nc = c + e.len / e.v
        if (nc < cost[o]) {
          cost[o] = nc
          prev[o] = n
          heap.push(nc, o)
        }
      }
    }
    const viaA = cost[ge.a] + (g.t * ge.len) / ge.v
    const viaB = cost[ge.b] + ((1 - g.t) * ge.len) / ge.v
    let n = viaA <= viaB ? ge.a : ge.b
    if (!isFinite(cost[n])) return null
    const chain = []
    for (; n !== -1; n = prev[n]) chain.push(n)
    chain.reverse()
    const pts = [s.x, s.z]
    for (const id of chain) pts.push(this.nodes[id].x, this.nodes[id].z)
    pts.push(g.x, g.z)
    let len = 0
    for (let i = 0; i + 3 < pts.length; i += 2) len += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1])
    return { pts, len }
  }
}
