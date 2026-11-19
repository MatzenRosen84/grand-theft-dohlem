// Car radio. Stations come from Radio Browser (radio-browser.info), a free,
// community-run directory of internet radio streams that needs no account or
// key. The streams themselves are played straight from the broadcasters.

const SERVERS = ['de1.api.radio-browser.info', 'de2.api.radio-browser.info', 'fi1.api.radio-browser.info', 'all.api.radio-browser.info']
const STORE = 'radio'

async function ask(path) {
  for (const host of SERVERS) {
    try {
      const res = await fetch(`https://${host}/json/${path}`, { signal: AbortSignal.timeout(6000) })
      if (res.ok) return await res.json()
    } catch {
      /* try the next mirror */
    }
  }
  return []
}

export class Radio {
  // onChange({ name, on, loading }) is called whenever something worth showing happens
  constructor(onChange = () => {}) {
    this.onChange = onChange
    this.stations = []
    this.index = -1 // -1: nothing chosen yet
    this.on = true
    this.failures = 0
    this.audio = new Audio()
    this.audio.preload = 'none'
    this.audio.volume = 0.5
    // a dead stream: move on to the next station, but give up after a few in a row
    this.audio.addEventListener('error', () => {
      if (!this.on || !this.audio.src) return
      if (++this.failures < 5) this.step(1)
      else this.announce('Kein Empfang')
    })
    this.audio.addEventListener('playing', () => {
      this.failures = 0
      this.announce()
    })
    try {
      const saved = JSON.parse(localStorage.getItem(STORE)) ?? {}
      this.wanted = saved.name
      this.on = saved.on ?? true
    } catch {
      /* no saved choice */
    }
  }

  // German stations people actually listen to, plus a few for the heavy stuff
  async load() {
    const common = 'hidebroken=true&is_https=true&order=clickcount&reverse=true'
    const [popular, metal, rock] = await Promise.all([
      ask(`stations/search?countrycode=DE&limit=40&${common}`),
      ask(`stations/search?tag=metal&limit=8&${common}`),
      ask(`stations/search?countrycode=DE&tag=rock&limit=8&${common}`),
    ])
    const seen = new Set()
    const pick = (list, n) =>
      list
        .filter((s) => s.url_resolved?.startsWith('https://') && !/m3u8?$|\.pls$/i.test(s.url_resolved) && ['MP3', 'AAC', 'AAC+', 'OGG'].includes(s.codec))
        .filter((s) => {
          const key = s.name.trim().toLowerCase().slice(0, 12)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .slice(0, n)
        .map((s) => ({ name: s.name.trim().slice(0, 34), url: s.url_resolved }))
    this.stations = [...pick(metal, 3), ...pick(rock, 3), ...pick(popular, 8)]
    const again = this.stations.findIndex((s) => s.name === this.wanted)
    this.index = again >= 0 ? again : 0
    return this.stations.length
  }

  get current() {
    return this.stations[this.index]
  }

  announce(note) {
    this.onChange({ name: note ?? (this.on ? this.current?.name : 'Radio aus') ?? 'Kein Sender', on: this.on && !!this.current })
  }

  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ name: this.current?.name, on: this.on }))
    } catch {
      /* not remembered */
    }
  }

  // start (or resume) the chosen station; call this from a click or key press
  play() {
    if (!this.on || !this.current) return this.announce()
    this.audio.src = this.current.url
    this.audio.play().catch(() => {})
    this.announce()
    this.save()
  }

  step(by) {
    if (!this.stations.length) return this.announce()
    this.on = true
    this.index = (this.index + by + this.stations.length) % this.stations.length
    this.play()
  }

  toggle() {
    this.on = !this.on
    if (this.on) this.play()
    else {
      this.audio.pause()
      this.audio.removeAttribute('src') // stop the download, not just the sound
      this.audio.load()
      this.announce()
      this.save()
    }
  }

  dispose() {
    this.audio.pause()
    this.audio.removeAttribute('src')
  }
}
