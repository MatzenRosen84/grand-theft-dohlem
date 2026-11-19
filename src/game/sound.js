// Engine, tyres, brakes and the evening in the village. Everything is made in
// the browser, so there are no sound files to load.
// Must be created from a click or key press, or the browser keeps it silent.

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export class Sound {
  constructor() {
    const Ctx = window.AudioContext ?? window.webkitAudioContext
    if (!Ctx) return
    const ctx = (this.ctx = new Ctx())
    this.out = ctx.createGain()
    this.out.gain.value = 0.32
    this.out.connect(ctx.destination)

    // two seconds of hiss, shared by everything that needs noise
    const len = ctx.sampleRate * 2
    this.hiss = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.hiss.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

    // --- engine. What makes an engine sound like one is the single bangs in
    // the exhaust, each a little different from the last. So: a recording-like
    // loop of exhaust pulses, played faster or slower with the revs. One loop
    // for low revs and one for high, blended, so neither is stretched too far.
    // Behind them sits the exhaust and the body of the car, which ring at the
    // same pitches whatever the engine does.
    this.low = this.pulses(1200, 92, 0.009)
    this.high = this.pulses(4000, 240, 0.0032)
    const muffler = (this.muffler = this.filter('lowpass', 500, 0.7))
    const boom = this.filter('peaking', 115, 1.4)
    boom.gain.value = 7
    const body = this.filter('peaking', 430, 1.2)
    body.gain.value = 4
    this.engine = this.gain(0)
    this.low.level.connect(muffler)
    this.high.level.connect(muffler)
    muffler.connect(boom).connect(body).connect(this.engine).connect(this.out)
    // air rushing into the intake under load
    this.intake = this.noise('bandpass', 380, 0.9)

    // --- wind and tyre roar, growing with speed
    this.road = this.noise('lowpass', 350, 0.5)
    // --- tyres sliding
    this.skid = this.noise('bandpass', 1150, 5)
    // --- brakes: pads rubbing on the discs
    this.rub = this.noise('bandpass', 2400, 1)

    // --- the village: a light breeze and a bird now and then, somewhere further off
    this.village = this.gain(1)
    this.village.connect(this.out)
    this.breeze = this.noise('lowpass', 380, 0.4, this.village)
    this.breeze.level.gain.value = 0.03
    this.sway(this.breeze.level.gain, 0.09, 0.013)
    this.far = this.filter('lowpass', 3600, 0.5) // distance takes the edge off
    this.far.connect(this.village)
    this.nextBird = 4

    this.hush = () => (document.hidden ? ctx.suspend() : ctx.resume())
    document.addEventListener('visibilitychange', this.hush)
  }

  gain(value) {
    const g = this.ctx.createGain()
    g.gain.value = value
    return g
  }

  filter(type, frequency, q) {
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = frequency
    f.Q.value = q
    return f
  }

  // A loop of exhaust pulses as the engine makes them at `rpm`: four bangs per
  // two turns of the crank, eight such cycles long. Every cylinder has its own
  // strength, and every bang lands a touch early or late. ring: pitch of the
  // pulse in Hz, fade: how fast it dies away in seconds.
  pulses(rpm, ring, fade) {
    const sr = this.ctx.sampleRate
    const cycle = (sr * 120) / rpm
    const CYCLES = 8
    const total = Math.round(cycle * CYCLES)
    const buffer = this.ctx.createBuffer(1, total, sr)
    const d = buffer.getChannelData(0)
    const cylinder = [1, 0.82, 1.08, 0.9]
    const span = Math.round(fade * 5 * sr)
    for (let c = 0; c < CYCLES; c++)
      for (let k = 0; k < 4; k++) {
        const start = Math.round((c + (k + (Math.random() - 0.5) * 0.06) / 4) * cycle)
        const amp = cylinder[k] * (0.88 + Math.random() * 0.24)
        for (let i = 0; i < span; i++) {
          const t = i / sr
          d[(start + i) % total] += amp * Math.exp(-t / fade) * (Math.sin(2 * Math.PI * ring * t) + (Math.random() - 0.5) * 0.5)
        }
      }
    let peak = 0
    for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(d[i]))
    for (let i = 0; i < total; i++) d[i] *= 0.9 / peak
    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.loop = true
    const level = this.gain(0)
    src.connect(level)
    src.start()
    return { src, level, rpm }
  }

  // looping noise through a filter, silent until its level is raised
  noise(type, frequency, q, to = this.out) {
    const src = this.ctx.createBufferSource()
    src.buffer = this.hiss
    src.loop = true
    const tone = this.filter(type, frequency, q)
    const level = this.gain(0)
    src.connect(tone).connect(level).connect(to)
    src.start(0, Math.random()) // so the layers don't all repeat together
    return { tone, level }
  }

  // slow wobble on a parameter: it swings by `depth` around its set value
  sway(param, rate, depth) {
    const lfo = this.ctx.createOscillator()
    lfo.frequency.value = rate
    const amount = this.gain(depth)
    lfo.connect(amount).connect(param)
    lfo.start()
  }

  // a short phrase of whistled notes somewhere off to one side
  bird() {
    const ctx = this.ctx
    const pan = ctx.createStereoPanner?.() ?? this.gain(1)
    if (pan.pan) pan.pan.value = Math.random() * 1.6 - 0.8
    pan.connect(this.far)
    const loud = 0.004 + Math.random() * 0.008 // near or far
    const base = 1900 + Math.random() * 1100
    let t = ctx.currentTime + 0.05
    const notes = 2 + ((Math.random() * 4) | 0)
    for (let i = 0; i < notes; i++) {
      const long = 0.09 + Math.random() * 0.16
      const from = base * (0.85 + Math.random() * 0.4)
      const o = ctx.createOscillator()
      const g = this.gain(0)
      o.frequency.setValueAtTime(from, t)
      o.frequency.exponentialRampToValueAtTime(from * (0.85 + Math.random() * 0.35), t + long)
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(loud, t + long * 0.3)
      g.gain.linearRampToValueAtTime(0, t + long)
      o.connect(g).connect(pan)
      o.start(t)
      o.stop(t + long + 0.02)
      t += long + 0.04 + Math.random() * 0.14
    }
    setTimeout(() => pan.disconnect(), (t - ctx.currentTime + 0.5) * 1000)
  }

  // one struck note, like a small bell: a clear tone with a glassy overtone that dies away
  note(pitch, at, long = 0.5, loud = 0.09) {
    const t = this.ctx.currentTime + at
    for (const [times, share] of [[1, 1], [2.76, 0.25]]) {
      const o = this.ctx.createOscillator()
      const g = this.gain(0)
      o.frequency.value = pitch * times
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(loud * share, t + 0.006)
      g.gain.exponentialRampToValueAtTime(0.0001, t + long / times)
      o.connect(g).connect(this.out)
      o.start(t)
      o.stop(t + long + 0.05)
    }
  }

  // short signals for what happens in the taxi
  ping(kind, delay = 0) {
    if (!this.ctx || this.ctx.state !== 'running') return
    // someone gets in: two notes going up
    if (kind === 'pickup') [660, 880].forEach((p, i) => this.note(p, i * 0.13))
    // arrived: the same two coming down, then the coins
    if (kind === 'dropoff') {
      ;[880, 660].forEach((p, i) => this.note(p, i * 0.13))
      this.ping('cash', 0.45)
    }
    // money in: two bright quick ones, like a till
    if (kind === 'cash') [1568, 2093].forEach((p, i) => this.note(p, delay + i * 0.08, 0.7, 0.07))
    // money gone: two dull ones going down
    if (kind === 'fine') [330, 247].forEach((p, i) => this.note(p, i * 0.16, 0.45, 0.11))
  }

  // once per frame. car: the Vehicle; quiet: true once the shift is over
  update(dt, car, quiet = false) {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return
    const t = ctx.currentTime
    const to = (param, value, lag = 0.05) => param.setTargetAtTime(value, t, lag)
    const speed = car.speed
    const revs = clamp((car.rpm - 900) / 5900, 0, 1) // 0 at idle, 1 at the red line
    const load = car.dead ? 0 : car.throttle

    to(this.low.src.playbackRate, car.rpm / this.low.rpm, 0.03)
    to(this.high.src.playbackRate, car.rpm / this.high.rpm, 0.03)
    const mix = smooth(1500, 3800, car.rpm)
    to(this.low.level.gain, Math.cos((mix * Math.PI) / 2))
    to(this.high.level.gain, Math.sin((mix * Math.PI) / 2))
    // foot down: the exhaust opens up; off the gas it is a muffled burble
    to(this.muffler.frequency, 380 + revs * 900 + load * (700 + revs * 1900), 0.07)
    to(this.engine.gain, car.dead ? 0 : (0.07 + revs * 0.05 + load * 0.12) * (quiet ? 0.5 : 1), 0.08)
    to(this.intake.tone.frequency, 300 + revs * 500)
    to(this.intake.level.gain, load * (0.006 + revs * 0.03), 0.08)

    to(this.road.tone.frequency, 260 + speed * 18)
    to(this.road.level.gain, clamp(speed / 45, 0, 1) ** 1.5 * 0.14, 0.15)

    const sliding = car.airborne ? 0 : car.slip
    to(this.skid.tone.frequency, 950 + clamp(speed, 0, 40) * 10)
    to(this.skid.level.gain, sliding * clamp(speed / 8, 0, 1) * 0.09, 0.05)

    const rolling = car.airborne ? 0 : clamp(speed / 18, 0, 1)
    to(this.rub.level.gain, car.brake * rolling * 0.03, 0.08)

    // at speed the car drowns out the village
    to(this.village.gain, 1 - 0.7 * clamp(speed / 22, 0, 1), 0.4)
    this.nextBird -= dt
    if (this.nextBird <= 0) {
      this.bird()
      // mostly a long pause, sometimes a quick second phrase
      this.nextBird = Math.random() < 0.25 ? 1 + Math.random() : 7 + Math.random() * 14
    }
  }

  dispose() {
    if (!this.ctx) return
    document.removeEventListener('visibilitychange', this.hush)
    this.ctx.close()
  }
}
