<script setup>
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { Game } from '../game/Game.js'
import SplashScreen from './SplashScreen.vue'
import { addResult, loadBest, loadName, saveName } from '../bestlist.js'
import { Radio } from '../radio.js'

const canvas = ref(null)
const radar = ref(null)
const game = shallowRef(null)

const loading = ref('Start')
const started = ref(false)
const error = ref('')
const hours = ref(20.5) // always sundown; there is no control for it
const showHelp = ref(true)
const driving = ref(true)
const stats = ref(null)
const toasts = ref([])
const hud = reactive({ street: '', compass: 'N', altitude: 0, fps: 0, scale: 100, speed: 0, gear: '1', rpm: 0, damage: 0, shift: 300, taxi: null })
const driver = ref(loadName())
const best = ref(loadBest())
const speech = ref('')
// car radio: the station name shows for a moment whenever it changes
const tuner = reactive({ name: '', on: false, show: false })
let tunerTimer = 0
const radio = new Radio((state) => {
  Object.assign(tuner, state, { show: true })
  clearTimeout(tunerTimer)
  tunerTimer = setTimeout(() => (tuner.show = false), 4000)
})
radio.load()
const intro = ref('') // 'story', then '3', '2', '1', 'Los!', then '' while playing
const guest = ref(null) // { name, line } while a passenger is talking
const gameOver = ref(null)
const cover = import.meta.env.BASE_URL + 'splash/cover.jpg'
const guestIcon = import.meta.env.BASE_URL + 'splash/guest.jpg'
const logo = import.meta.env.BASE_URL + 'splash/logo.png'

// touch devices get an on-screen stick; phones also start on low graphics without the heavy models
// (?touch in the address forces the touch controls on, for trying them with a mouse)
const touch = matchMedia('(pointer: coarse)').matches || new URLSearchParams(location.search).has('touch')
// lite: low graphics and the simple built-in models. Phones always; other
// machines once the game has found them too slow (remembered in the browser).
const tooSlow = (() => {
  try {
    return localStorage.getItem('lite') === '1'
  } catch {
    return false
  }
})()
const lite = tooSlow || (touch && Math.min(screen.width, screen.height) < 820)
// small HUD for touch devices and small windows
const compact = ref(false)
// The small layout is drawn for a phone held sideways (844 x 390) and scaled
// as a whole to whatever screen it runs on, so nothing can drift into
// anything else on a smaller or larger phone.
const hudScale = ref(1)
const upright = ref(false) // phone held in portrait
const fit = () => {
  compact.value = touch || innerWidth < 900 || innerHeight < 520
  upright.value = innerHeight > innerWidth
  hudScale.value = compact.value ? Math.min(1.5, Math.max(0.55, Math.min(innerWidth / 844, innerHeight / 390))) : 1
}
fit()
window.addEventListener('resize', fit)
window.addEventListener('orientationchange', fit)
// graphics are fixed: medium everywhere, low on phones, which could not keep up otherwise
const quality = lite ? 'low' : 'medium'

// The stick presses the same keys the keyboard would: up is gas, down is
// brake and reverse, left and right steer.
const knob = reactive({ x: 0, y: 0 })
const press = (code, down) => {
  const keys = game.value?.rig?.keys
  if (keys) down ? keys.add(code) : keys.delete(code)
}
function stickMove(e) {
  const r = e.currentTarget.getBoundingClientRect()
  let dx = e.clientX - (r.left + r.width / 2)
  let dy = e.clientY - (r.top + r.height / 2)
  const max = r.width / 2 - 20
  const len = Math.hypot(dx, dy)
  if (len > max) {
    dx *= max / len
    dy *= max / len
  }
  knob.x = dx / hudScale.value // the stick itself is drawn scaled
  knob.y = dy / hudScale.value
  press('KeyA', dx < -max * 0.3)
  press('KeyD', dx > max * 0.3)
  press('KeyW', dy < -max * 0.3)
  press('KeyS', dy > max * 0.3)
}
function stickStart(e) {
  try {
    e.currentTarget.setPointerCapture(e.pointerId) // keeps the stick when the thumb slides off it
  } catch {
    /* not every browser allows it; the stick still works while the thumb stays on it */
  }
  stickMove(e)
}
function stickEnd() {
  knob.x = knob.y = 0
  for (const code of ['KeyA', 'KeyD', 'KeyW', 'KeyS']) press(code, false)
}

const clock = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
const euro = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const metres = (m) => (m >= 1000 ? (m / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 }) + ' km' : Math.round(m / 10) * 10 + ' m')
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

watch(hours, (h) => game.value?.setTime(Number(h)))

// what the driver says, shown in a bubble over the car for a moment
let speechTimer = 0
function say(text) {
  speech.value = text
  clearTimeout(speechTimer)
  speechTimer = setTimeout(() => (speech.value = ''), 3600)
}

let guestTimer = 0
function guestSays(name, line) {
  guest.value = { name, line }
  clearTimeout(guestTimer)
  guestTimer = setTimeout(() => (guest.value = null), 3500 + line.length * 60)
}

function restart() {
  gameOver.value = null
  toasts.value = []
  game.value.restart()
  countdown()
}

let toastId = 0
function toast(text, kind) {
  const id = ++toastId
  toasts.value = [...toasts.value.slice(-3), { id, text, kind }]
  // long lines stay up longer
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), 4500 + text.length * 55)
}

onMounted(async () => {
  const g = new Game(
    canvas.value,
    {
      onProgress: (text) => (loading.value = text),
      onHud: (data) => Object.assign(hud, data),
      onMode: (on) => (driving.value = on),
      onToast: toast,
      onSpeech: say,
      onSlow: () => {
        try {
          localStorage.setItem('lite', '1')
        } catch {
          /* not remembered */
        }
        toast('Die Grafikkarte kommt nicht mit. Ab dem nächsten Start läuft das Spiel mit einfacherer Grafik.', 'bad')
      },
      onGuest: guestSays,
      onGameOver: (result) => {
        // into the best list, then show where that put the driver
        const { list, rank } = addResult({ name: driver.value, cash: Math.round(result.cash * 100) / 100, trips: result.trips, reason: result.reason })
        best.value = list
        gameOver.value = { ...result, rank }
      },
    },
    quality,
    { lite },
  )
  game.value = g
  if (import.meta.env.DEV) window.game = g
  try {
    stats.value = await g.load()
    g.setTime(hours.value)
    g.attachMinimap(radar.value)
  } catch (err) {
    console.error(err)
    error.value = err.message
  }
})

// leave the splash screen and start driving
function begin(name) {
  if (started.value || loading.value || error.value) return
  driver.value = name
  saveName(name)
  started.value = true
  // phones: fill the whole screen and stay in landscape, where the browser allows it
  if (touch) {
    const root = document.documentElement
    const full = root.requestFullscreen?.bind(root) ?? root.webkitRequestFullscreen?.bind(root)
    Promise.resolve(full?.())
      .then(() => screen.orientation?.lock?.('landscape'))
      .catch(() => {})
  }
  game.value.frozen = true
  game.value.start()
  intro.value = 'story'
}

// 3, 2, 1, Los! and only then does the shift clock run
function countdown() {
  if (intro.value && intro.value !== 'story') return
  game.value.frozen = true
  const steps = ['3', '2', '1', 'Los!']
  const next = () => {
    intro.value = steps.shift() ?? ''
    if (intro.value === 'Los!') {
      game.value.frozen = false
      if (radio.audio.paused) radio.play() // music from the first metre
    }
    if (intro.value) setTimeout(next, intro.value === 'Los!' ? 700 : 850)
  }
  next()
}
const onIntroKey = (e) => {
  // radio: 1 and 2 change the station, M switches it off and on
  if (started.value && !intro.value && !(e.target instanceof HTMLInputElement) && !e.repeat) {
    if (e.code === 'Digit1') radio.step(-1)
    if (e.code === 'Digit2') radio.step(1)
    if (e.code === 'KeyM') radio.toggle()
  }
  if (intro.value === 'story' && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) countdown()
}
window.addEventListener('keydown', onIntroKey)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onIntroKey)
  window.removeEventListener('resize', fit)
  window.removeEventListener('orientationchange', fit)
  radio.dispose()
  game.value?.dispose()
})
</script>

<template>
  <div class="view" :class="{ compact }" :style="{ '--hud': hudScale }">
    <canvas ref="canvas" class="scene"></canvas>

    <SplashScreen v-if="!started" :status="loading" :ready="!loading && !error" :error="error" :name="driver" :best="best" @start="begin" />

    <!-- upright phone: covers everything, splash screen included, until it is turned -->
    <div v-if="touch && upright" class="turn">
      <img :src="logo" alt="Grand Theft Dohlem" />
      <span class="phone" aria-hidden="true"></span>
      <p>Dreh dein Handy quer</p>
    </div>

    <template v-else>
      <header class="title">
        <img class="logo-img" :src="logo" alt="Grand Theft Dohlem" />
        <small v-if="stats">{{ hud.fps }} fps<template v-if="hud.scale < 100"> · {{ hud.scale }} % Auflösung</template></small>
      </header>

      <div v-if="hud.taxi" class="wallet box">
        <div class="cash" :class="{ debt: hud.taxi.cash < 0 }">{{ euro(hud.taxi.cash) }}</div>
        <div class="trips">{{ driver }} · {{ hud.taxi.trips }} {{ hud.taxi.trips === 1 ? 'Fahrt' : 'Fahrten' }}</div>
        <div class="shift" :class="{ late: hud.shift < 30 }">Schicht {{ mmss(hud.shift) }}</div>
      </div>

      <div v-if="showHelp" class="help box" @click="showHelp = false">
        <template v-if="driving">
          <p><kbd>W</kbd><kbd>S</kbd> Gas, Bremse / rückwärts · <kbd>A</kbd><kbd>D</kbd> lenken</p>
          <p><kbd>Leertaste</kbd> Handbremse · <kbd>R</kbd> zurück auf die Straße · <kbd>L</kbd> Licht</p>
          <p>Neben einem winkenden Besoffskie anhalten, dann steigt er ein</p>
          <p><kbd>1</kbd><kbd>2</kbd> Radiosender · <kbd>M</kbd> Radio aus/an</p>
          <p><kbd>C</kbd> freie Kamera · Klick blendet die Hilfe aus</p>
        </template>
        <template v-else>
          <p><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> bewegen · <kbd>Umschalt</kbd> schneller</p>
          <p>Ziehen zum Umsehen · Mausrad zoomt</p>
          <p><kbd>C</kbd> zurück zum Auto</p>
        </template>
      </div>

      <!-- radio: station name at the top, like tuning a car radio -->
      <div class="radio box" :class="{ off: !tuner.on, show: tuner.show }" @click="radio.step(1)">
        <span class="note">♪</span>
        <b>{{ tuner.name || 'Radio' }}</b>
        <small><kbd>1</kbd><kbd>2</kbd> Sender · <kbd>M</kbd> aus/an</small>
      </div>

      <transition-group name="toast" tag="div" class="toasts">
        <div v-for="t in toasts" :key="t.id" class="toast box" :class="t.kind">{{ t.text }}</div>
      </transition-group>

      <!-- what the passenger says when getting in -->
      <div class="guest-spot">
        <transition name="pop">
          <div v-if="guest && driving" class="guest">
            <i class="face" :style="{ backgroundImage: `url(${guestIcon})` }"></i>
            <b>{{ guest.name }}</b>
            <p>{{ guest.line }}</p>
          </div>
        </transition>
      </div>

      <div v-if="driving && hud.taxi" class="job box" :class="{ riding: hud.taxi.state === 'fare' || hud.taxi.state === 'boarding' }">
        <i v-if="hud.taxi.state === 'fare' || hud.taxi.state === 'boarding'" class="face" :style="{ backgroundImage: `url(${guestIcon})` }"></i>
        <div class="task">{{ hud.taxi.text }}</div>
        <div v-if="hud.taxi.state === 'fare'" class="meter">
          <span>{{ metres(hud.taxi.distance) }}</span>
          <div class="bar"><i :style="{ width: hud.taxi.patience * 100 + '%' }" :class="{ late: hud.taxi.patience < 0.25 }"></i></div>
          <span>{{ mmss(hud.taxi.timeLeft) }}</span>
        </div>
        <div v-else-if="hud.taxi.state === 'cruise' && hud.taxi.distance" class="meter">
          <span>nächster: {{ metres(hud.taxi.distance) }}</span>
        </div>
      </div>

      <div v-if="driving" class="dash box">
        <div class="speed">{{ hud.speed }}<small>km/h</small></div>
        <div class="gear">{{ hud.gear }}</div>
        <div class="rev"><i :style="{ width: Math.min(1, hud.rpm) * 100 + '%' }" :class="{ red: hud.rpm > 0.9 }"></i></div>
        <div class="wear">
          <span>Schaden {{ hud.damage }} %</span>
          <div class="rev"><i :style="{ width: hud.damage + '%' }" :class="{ red: hud.damage >= 70, ok: hud.damage < 35 }"></i></div>
        </div>
      </div>

      <!-- the driver: his head from the cover art, and what he has to say -->
      <div v-if="driving" class="driver" :class="{ talking: speech }">
        <div class="head" :style="{ backgroundImage: `url(${cover})` }" role="img" :aria-label="driver"></div>
        <transition name="pop">
          <div v-if="speech" class="speech">{{ speech }}</div>
        </transition>
      </div>

      <!-- the story in a few lines, then the countdown -->
      <div v-if="intro === 'story'" class="story">
        <div class="card box">
          <div class="head" :style="{ backgroundImage: `url(${cover})` }"></div>
          <img class="card-logo" :src="logo" alt="Grand Theft Dohlem" />
          <p>Das halbe Dorf ist voll. <b>Du</b> fährst sie heim.</p>
          <p><b>5 Minuten</b> Schicht. Tempo gibt Trinkgeld, Dellen kosten.</p>
          <p class="motto">Was kostet die Welt? Der Babben bezahlt.</p>
          <button class="btn" @click="countdown">Los geht's</button>
        </div>
      </div>
      <div v-else-if="intro" class="count">
        <span :key="intro" :class="{ go: intro === 'Los!' }">{{ intro }}</span>
      </div>

      <!-- touch: stick on the left, handbrake and reset on the right -->
      <div v-if="touch && driving && !intro && !gameOver" class="pad">
        <div class="stick" @pointerdown.prevent="stickStart" @pointermove.prevent="stickMove" @pointerup="stickEnd" @pointercancel="stickEnd">
          <i :style="{ transform: `translate(${knob.x}px, ${knob.y}px)` }"></i>
        </div>
        <div class="taps">
          <button class="btn" @click="game.resetCar()">Straße</button>
          <button class="btn hand" @pointerdown.prevent="press('Space', true)" @pointerup="press('Space', false)" @pointercancel="press('Space', false)" @pointerleave="press('Space', false)">Hand&shy;bremse</button>
        </div>
      </div>

      <div v-if="gameOver" class="over">
        <h2>{{ gameOver.reason === 'wreck' ? 'Totalschaden' : 'Feierabend' }}</h2>
        <p v-if="gameOver.reason === 'wreck'">Der Calibra ist hin. Diesmal bezahlt der Babben nicht.</p>
        <p v-else>Die Schicht ist rum.</p>
        <p class="result">{{ driver }}: {{ euro(gameOver.cash) }} · {{ gameOver.trips }} {{ gameOver.trips === 1 ? 'Fahrt' : 'Fahrten' }}<template v-if="gameOver.rank"> · Platz {{ gameOver.rank }}</template></p>
        <ol class="best">
          <li v-for="(e, i) in best.slice(0, 8)" :key="e.id" :class="{ me: i + 1 === gameOver.rank }">
            <span>{{ i + 1 }}.</span><b>{{ e.name }}</b><i>{{ e.trips }} F.</i><em>{{ euro(e.cash) }}</em>
          </li>
        </ol>
        <button class="btn" @click="restart">Neue Schicht</button>
      </div>

      <div class="place">
        <div class="street">{{ hud.street || 'Freies Feld' }}</div>
        <div class="area">Thalheim · {{ hud.altitude }} m · {{ hud.compass }}</div>
      </div>

      <footer class="credits">Kartendaten © OpenStreetMap-Mitwirkende</footer>
    </template>

    <canvas v-show="started" ref="radar" class="radar" width="440" height="320"></canvas>
  </div>
</template>

<style scoped>
.view {
  position: fixed;
  inset: 0;
  touch-action: none; /* no page scrolling or pinch zoom while playing */
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
  overflow: hidden;
  color: var(--paper);
  user-select: none;
}
.scene {
  width: 100%;
  height: 100%;
  display: block;
  touch-action: none;
}

.title {
  position: absolute;
  top: 12px;
  left: 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  pointer-events: none;
  transform: rotate(-2deg);
}
/* the logo from the cover art, cut free of its background */
.logo-img {
  width: 172px;
  height: auto;
  filter: drop-shadow(4px 5px 0 rgba(11, 9, 22, 0.55));
}
.title small {
  font-size: 0.7rem;
  text-shadow: 0 1px 3px var(--ink);
}

/* earnings, driver, shift clock */
.wallet {
  position: absolute;
  top: 14px;
  right: 22px;
  padding: 6px 16px 8px;
  text-align: right;
  pointer-events: none;
  transform: rotate(1.5deg);
}
.cash {
  font-family: var(--display);
  font-size: 2rem;
  line-height: 1.1;
  color: var(--good);
  -webkit-text-stroke: 4px var(--ink);
  paint-order: stroke fill;
  font-variant-numeric: tabular-nums;
}
.cash.debt {
  color: var(--hot);
}
.trips {
  font-size: 0.8rem;
}
.shift {
  font-family: var(--comic);
  font-size: 1.35rem;
  letter-spacing: 0.05em;
  color: var(--gold);
  font-variant-numeric: tabular-nums;
}
.shift.late {
  color: var(--hot);
}

.panel {
  position: absolute;
  top: 128px;
  right: 22px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
.row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.row input {
  width: 130px;
  accent-color: var(--sun);
}
.row button {
  padding: 1px 9px;
  color: var(--paper);
  background: var(--ink);
  border: 2px solid var(--ink);
  border-radius: 6px;
  font-family: var(--comic);
  font-size: 0.95rem;
  letter-spacing: 0.04em;
  cursor: pointer;
}
.row button.on {
  color: var(--ink);
  background: var(--gold);
}

.help {
  position: absolute;
  top: 128px;
  right: 22px;
  padding: 10px 14px;
  font-size: 0.8rem;
  line-height: 1.9;
  cursor: pointer;
}
.help p {
  margin: 0;
}
kbd {
  display: inline-block;
  min-width: 1.5em;
  margin-right: 3px;
  padding: 0 5px;
  color: var(--ink);
  background: var(--paper);
  border: 2px solid var(--ink);
  border-radius: 5px;
  box-shadow: 1px 2px 0 var(--ink);
  font-family: var(--comic);
  font-size: 0.85rem;
  line-height: 1.4;
  text-align: center;
}

/* radio: a small tag at the top; it grows and shows the keys while the station changes */
.radio {
  position: absolute;
  top: 12px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 60vw;
  padding: 4px 16px;
  transform: translateX(-50%) rotate(-1deg);
  opacity: 0.6;
  transition: opacity 0.3s, transform 0.2s;
  white-space: nowrap;
  cursor: pointer;
}
.radio.show {
  opacity: 1;
  transform: translateX(-50%) rotate(-1deg) scale(1.12);
}
.radio b {
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--comic);
  font-size: 1.35rem;
  font-weight: 400;
  letter-spacing: 0.05em;
  color: var(--gold);
}
.radio.off b {
  color: #9aa0b5;
}
.radio .note {
  font-size: 1.2rem;
  color: var(--sun);
}
.radio small {
  display: none;
  font-size: 0.75rem;
}
.radio.show small {
  display: inline;
}

.toasts {
  position: absolute;
  top: 64px;
  left: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  transform: translateX(-50%);
  pointer-events: none;
}
.toast {
  max-width: min(92vw, 640px);
  padding: 6px 16px;
  font-size: 0.95rem;
  text-align: center;
  box-shadow: 0 0 0 2px var(--gold), 5px 6px 0 var(--ink);
}
.toast.good {
  box-shadow: 0 0 0 2px var(--good), 5px 6px 0 var(--ink);
}
.toast.bad {
  box-shadow: 0 0 0 2px var(--hot), 5px 6px 0 var(--ink);
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* the passenger's picture: beside the speech bubble, and on the job banner during the ride */
.face {
  position: absolute;
  background-size: 104%;
  background-position: center;
  border: 4px solid var(--ink);
  border-radius: 50%;
  box-shadow: 0 0 0 3px var(--sun), 4px 5px 0 var(--ink);
}
.guest .face {
  left: -96px;
  top: 50%;
  width: 112px;
  height: 112px;
  transform: translateY(-50%) rotate(-4deg);
}
.job .face {
  left: -30px;
  top: 50%;
  width: 62px;
  height: 62px;
  transform: translateY(-50%);
}
.job.riding {
  padding-left: 46px;
}

/* the passenger's line: a big bubble with a name tag, top centre */
.guest-spot {
  position: absolute;
  top: 118px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
}
.guest {
  position: relative;
  max-width: min(86vw, 720px);
  margin-left: 96px;
  padding: 20px 28px 14px 36px;
  color: var(--ink);
  background: var(--paper);
  border: 5px solid var(--ink);
  border-radius: 26px;
  box-shadow: 0 0 0 3px var(--hot), 7px 8px 0 var(--ink);
  transform: rotate(1.5deg);
}
.guest b {
  position: absolute;
  top: -20px;
  left: 34px;
  padding: 1px 14px;
  color: var(--ink);
  background: linear-gradient(var(--gold), var(--sun));
  border: 4px solid var(--ink);
  border-radius: 10px;
  font-family: var(--display);
  font-size: 1.05rem;
  font-weight: 400;
  text-transform: lowercase;
  transform: rotate(-3deg);
}
.guest p {
  margin: 0;
  font-family: var(--comic);
  font-size: clamp(1.4rem, 2.3vw, 2.1rem);
  line-height: 1.15;
  letter-spacing: 0.03em;
  text-align: center;
}
/* tail pointing down at the car */
.guest::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -19px;
  width: 28px;
  height: 28px;
  background: var(--paper);
  border-right: 5px solid var(--ink);
  border-bottom: 5px solid var(--ink);
  transform: translateX(-50%) rotate(45deg);
}

/* the current job */
.job {
  position: absolute;
  left: 50%;
  bottom: 24px;
  padding: 6px 20px 8px;
  transform: translateX(-50%) rotate(-1deg);
  text-align: center;
  pointer-events: none;
}
.task {
  font-family: var(--comic);
  font-size: 1.5rem;
  letter-spacing: 0.04em;
}
.meter {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 2px;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
}
.bar,
.rev {
  height: 9px;
  background: var(--ink);
  border: 2px solid var(--ink);
  border-radius: 5px;
  overflow: hidden;
}
.bar {
  width: 180px;
}
.bar i,
.rev i {
  display: block;
  height: 100%;
  background: var(--good);
}
.bar i.late,
.rev i.red {
  background: var(--hot);
}

.radar {
  position: absolute;
  left: 20px;
  bottom: 20px;
  width: 220px;
  height: 160px;
  border: 3px solid var(--ink);
  border-radius: 8px;
  box-shadow: 0 0 0 2px var(--hot), 5px 6px 0 var(--ink);
  pointer-events: none;
}

/* speed, gear, revs, damage */
.dash {
  position: absolute;
  left: 262px;
  bottom: 20px;
  display: grid;
  grid-template-columns: auto auto;
  align-items: baseline;
  column-gap: 12px;
  padding: 4px 14px 10px;
  pointer-events: none;
}
.speed {
  font-family: var(--display);
  font-size: 2.3rem;
  line-height: 1.15;
  -webkit-text-stroke: 4px var(--ink);
  paint-order: stroke fill;
  font-variant-numeric: tabular-nums;
}
.speed small {
  margin-left: 6px;
  font-family: var(--comic);
  font-size: 1rem;
  -webkit-text-stroke: 0;
}
.gear {
  font-family: var(--display);
  font-size: 1.5rem;
  color: var(--gold);
  -webkit-text-stroke: 3px var(--ink);
  paint-order: stroke fill;
}
.rev {
  grid-column: 1 / -1;
  width: 160px;
}
.rev i {
  background: var(--sun);
}
.rev i.ok {
  background: var(--good);
}
.wear {
  grid-column: 1 / -1;
  margin-top: 6px;
  font-family: var(--comic);
  font-size: 0.95rem;
  letter-spacing: 0.04em;
}
.wear .rev {
  margin-top: 2px;
}

/* the driver's head sits above the radar; his lines pop out next to it */
.driver {
  position: absolute;
  left: 20px;
  bottom: 196px;
  display: flex;
  align-items: center;
  gap: 18px;
  pointer-events: none;
}
.head {
  flex: none;
  width: 104px;
  height: 104px;
  /* the cover is 2752 x 1536; this window frames the face */
  background-size: 640% auto;
  background-position: 20.3% 12.5%;
  background-color: var(--dusk);
  border: 4px solid var(--ink);
  border-radius: 50%;
  box-shadow: 0 0 0 3px var(--sun), 5px 6px 0 var(--ink);
}
.talking .head {
  animation: nod 0.45s ease-in-out infinite alternate;
}
@keyframes nod {
  to {
    transform: translateY(-4px) rotate(-3deg);
  }
}
.speech {
  position: relative;
  max-width: min(60vw, 460px);
  padding: 10px 20px;
  color: var(--ink);
  background: var(--paper);
  border: 4px solid var(--ink);
  border-radius: 20px;
  box-shadow: 5px 6px 0 var(--ink);
  font-family: var(--comic);
  font-size: 1.6rem;
  letter-spacing: 0.03em;
  transform: rotate(-2deg);
}
/* tail pointing at the head */
.speech::before {
  content: '';
  position: absolute;
  left: -15px;
  top: 50%;
  width: 22px;
  height: 22px;
  background: var(--paper);
  border-left: 4px solid var(--ink);
  border-bottom: 4px solid var(--ink);
  transform: translateY(-50%) rotate(45deg);
}
.pop-enter-active {
  transition: transform 0.18s cubic-bezier(0.3, 1.6, 0.6, 1), opacity 0.18s;
}
.pop-leave-active {
  transition: opacity 0.3s;
}
.pop-enter-from {
  opacity: 0;
  transform: rotate(-2deg) scale(0.6);
}
.pop-leave-to {
  opacity: 0;
}

.place {
  position: absolute;
  right: 24px;
  bottom: 30px;
  text-align: right;
  pointer-events: none;
}
.street {
  font-family: var(--comic);
  font-size: 1.9rem;
  letter-spacing: 0.04em;
  -webkit-text-stroke: 4px var(--ink);
  paint-order: stroke fill;
}
.area {
  font-size: 0.9rem;
  text-shadow: 0 1px 4px var(--ink), 0 0 2px var(--ink);
}
.credits {
  position: absolute;
  right: 24px;
  bottom: 8px;
  font-size: 0.65rem;
  opacity: 0.8;
  text-shadow: 0 1px 3px var(--ink);
  pointer-events: none;
}

/* story card before the first shift */
.story {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  background: rgba(11, 9, 22, 0.72);
}
.card {
  position: relative;
  width: min(88vw, 620px);
  padding: 26px 34px 26px;
  text-align: center;
  transform: rotate(-1deg);
}
.card .head {
  position: absolute;
  top: -66px;
  left: -58px;
  transform: rotate(-6deg);
}
.card-logo {
  display: block;
  width: min(46vw, 230px);
  margin: 0 auto 14px;
  filter: drop-shadow(4px 5px 0 rgba(11, 9, 22, 0.55));
}
.card p {
  margin: 0 0 10px;
  font-size: 1.08rem;
  line-height: 1.45;
}
.card b {
  color: var(--gold);
}
.card .motto {
  margin: 16px 0 18px;
  color: var(--gold);
  font-family: var(--comic);
  font-size: 1.7rem;
  letter-spacing: 0.04em;
}

/* 3, 2, 1, Los! */
.count {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  pointer-events: none;
}
.count span {
  color: var(--paper);
  font-family: var(--display);
  font-size: clamp(8rem, 30vw, 20rem);
  line-height: 1;
  -webkit-text-stroke: 18px var(--ink);
  paint-order: stroke fill;
  text-shadow: 10px 10px 0 var(--hot);
  animation: slam 0.8s cubic-bezier(0.2, 1.5, 0.4, 1) both;
}
.count span.go {
  color: var(--gold);
  font-size: clamp(6rem, 22vw, 15rem);
  text-transform: lowercase;
}
@keyframes slam {
  0% {
    opacity: 0;
    transform: scale(2.4) rotate(-8deg);
  }
  35% {
    opacity: 1;
    transform: scale(1) rotate(-4deg);
  }
  80% {
    opacity: 1;
    transform: scale(1) rotate(-4deg);
  }
  100% {
    opacity: 0;
    transform: scale(0.85) rotate(-4deg);
  }
}

/* touch controls */
.pad {
  position: absolute;
  inset: auto 0 0 0;
  z-index: 4;
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  padding: 0 max(18px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(18px, env(safe-area-inset-left));
  pointer-events: none;
}
.stick {
  position: relative;
  width: 150px;
  height: 150px;
  background: rgba(26, 22, 56, 0.55);
  border: 4px solid var(--ink);
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--hot);
  touch-action: none;
  pointer-events: auto;
}
.stick i {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 66px;
  height: 66px;
  margin: -33px;
  background: linear-gradient(var(--gold), var(--sun));
  border: 4px solid var(--ink);
  border-radius: 50%;
  box-shadow: 3px 4px 0 var(--ink);
}
.taps {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  pointer-events: auto;
}
.taps .btn {
  font-size: 1.1rem;
  touch-action: none;
}
.taps .hand {
  width: 104px;
  height: 104px;
  border-radius: 50%;
  line-height: 1.05;
}

/* touch devices and small windows (.compact on the root): smaller HUD, nothing under the thumbs.
   Every HUD element is scaled by --hud, which the script sets from the screen size. */
.compact > :not(.scene):not(.splash) {
  zoom: var(--hud, 1);
}
.compact .help,
.compact .panel,
.compact .credits,
.compact .title small,
.compact .area,
.compact .radio small {
  display: none !important;
}
.compact .logo-img {
  width: 84px;
}
.compact .title {
  top: 6px;
  left: 10px;
}
.compact .wallet {
  top: 6px;
  right: 8px;
  padding: 2px 10px 4px;
}
.compact .cash {
  font-size: 1.3rem;
  -webkit-text-stroke-width: 3px;
}
.compact .trips {
  display: none;
}
.compact .shift {
  font-size: 1rem;
}
.compact .radio {
  top: 6px;
  padding: 2px 12px;
}
.compact .radio b {
  font-size: 1rem;
}
.compact .radar {
  left: 10px;
  top: 84px;
  bottom: auto;
  width: 124px;
  height: 90px;
}
.compact .driver {
  left: 148px;
  top: 52px;
  bottom: auto;
  gap: 12px;
}
.compact .driver .head {
  width: 58px;
  height: 58px;
}
.compact .speech {
  padding: 6px 12px;
  font-size: 1.05rem;
  border-width: 3px;
}
.compact .guest-spot {
  top: 44px;
}
.compact .guest {
  margin-left: 60px;
  padding: 12px 16px 8px 24px;
  border-width: 4px;
}
.compact .guest p {
  font-size: 1.05rem;
}
.compact .guest .face {
  left: -62px;
  width: 70px;
  height: 70px;
}
.compact .job {
  left: 58%; /* a little right of centre, clear of the speedometer */
  bottom: 8px;
  padding: 3px 12px 4px;
}
.compact .task {
  font-size: 1rem;
}
.compact .meter {
  font-size: 0.75rem;
}
.compact .bar {
  width: 110px;
}
.compact .dash {
  /* beside the stick, clear of the car in the middle */
  left: 190px;
  bottom: 14px;
  padding: 2px 10px 6px;
}
.compact .speed {
  font-size: 1.4rem;
  -webkit-text-stroke-width: 3px;
}
.compact .gear {
  font-size: 1rem;
}
.compact .rev {
  width: 110px;
}
.compact .wear {
  margin-top: 2px;
  font-size: 0.75rem;
}
.compact .place {
  right: 10px;
  bottom: auto;
  top: 58px;
}
.compact .street {
  font-size: 1.05rem;
  -webkit-text-stroke-width: 3px;
}
.compact .toasts {
  top: 40px;
}
.compact .toast {
  padding: 3px 10px;
  font-size: 0.8rem;
}
.compact .card {
  max-height: 92vh;
  padding: 16px 20px;
  overflow: auto;
}
.compact .card .head {
  display: none;
}
.compact .card-logo {
  width: 120px;
  margin-bottom: 6px;
}
.compact .card p {
  font-size: 0.92rem;
  margin-bottom: 6px;
}
.compact .card .motto {
  margin: 8px 0 10px;
  font-size: 1.2rem;
}
.compact .over {
  gap: 4px;
  overflow: auto;
}
.compact .over .result {
  font-size: 1.15rem;
}
.compact .best li {
  padding: 1px 10px;
  font-size: 0.85rem;
}
/* upright phone: ask for landscape (rendered only while a touch device is held upright) */
.turn {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 28px;
  padding: 24px;
  color: var(--gold);
  background: linear-gradient(160deg, var(--dusk), var(--ink) 70%);
  font-family: var(--comic);
  font-size: 2rem;
  letter-spacing: 0.04em;
  text-align: center;
}
.turn img {
  width: min(62vw, 300px);
}
.turn p {
  margin: 0;
}
/* a little phone that tips over onto its side */
.turn .phone {
  width: 54px;
  height: 96px;
  border: 5px solid var(--paper);
  border-radius: 12px;
  box-shadow: 0 0 0 2px var(--hot), 5px 6px 0 var(--ink);
  animation: tip 1.8s ease-in-out infinite;
}
@keyframes tip {
  0%,
  25% {
    transform: rotate(0deg);
  }
  60%,
  100% {
    transform: rotate(-90deg);
  }
}

/* end of shift */
.over {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 10px;
  text-align: center;
  background: rgba(11, 9, 22, 0.84);
}
.over h2 {
  margin: 0;
  color: var(--paper);
  font-family: var(--display);
  font-size: clamp(2.6rem, 9vw, 6rem);
  font-weight: 400;
  text-transform: lowercase;
  -webkit-text-stroke: 10px var(--ink);
  paint-order: stroke fill;
  text-shadow: 5px 5px 0 var(--hot);
  transform: rotate(-3deg);
}
.over p {
  margin: 0;
  font-size: 1.1rem;
}
.over .result {
  font-family: var(--comic);
  font-size: 1.7rem;
  letter-spacing: 0.04em;
  color: var(--gold);
}
.best {
  width: min(86vw, 430px);
  margin: 6px 0 10px;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}
.best li {
  display: grid;
  grid-template-columns: 2em 1fr auto 6.5em;
  gap: 8px;
  padding: 4px 10px;
  text-align: left;
  border-radius: 6px;
}
.best li:nth-child(odd) {
  background: rgba(255, 255, 255, 0.07);
}
.best li.me {
  color: var(--ink);
  background: var(--gold);
}
.best i {
  font-style: normal;
  opacity: 0.75;
}
.best em {
  font-style: normal;
  text-align: right;
}

@media (prefers-reduced-motion: reduce) {
  .talking .head,
  .count span,
  .turn .phone {
    animation: none !important;
  }
}
</style>
