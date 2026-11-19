<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ status: String, ready: Boolean, error: String, progress: Number, name: String, best: Array })
const emit = defineEmits(['start'])

const cover = import.meta.env.BASE_URL + 'splash/cover.jpg'
const driver = ref(props.name ?? '')
const field = ref(null)
const euro = (v) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'

// a shift needs a name for the best list
function start() {
  const name = driver.value.trim().slice(0, 16)
  if (!props.ready) return
  // no name typed (fiddly on a phone): drive as "Fahrer"
  emit('start', name || 'Fahrer')
}

const onKey = (e) => {
  if (e.code === 'Enter' || e.code === 'NumpadEnter') start()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="splash">
    <img class="cover" :src="cover" alt="Grand Theft Dohlem" />

    <!-- name, start, best list -->
    <form class="desk box" @submit.prevent="start">
      <div class="line">
        <label for="driver">Dein Name</label>
        <input id="driver" ref="field" v-model="driver" maxlength="16" autocomplete="off" spellcheck="false" placeholder="z. B. Babbe" />
        <button class="btn" type="submit" :disabled="!ready">{{ ready ? 'Schicht starten' : 'Lädt …' }}</button>
      </div>
      <div class="line">
        <h2>Bestenliste</h2>
        <p v-if="error" class="error">{{ error }}</p>
        <p v-else-if="!ready" class="busy">{{ status }} …</p>
        <ol v-else-if="best?.length">
          <li v-for="(e, i) in best.slice(0, 3)" :key="e.id"><span>{{ i + 1 }}.</span><b>{{ e.name }}</b><em>{{ euro(e.cash) }}</em></li>
        </ol>
        <p v-else>5 Minuten Schicht. Wer die meisten Euro einfährt, steht hier oben.</p>
      </div>
      <!-- loading bar; gone once the game is ready -->
      <div v-if="!ready && !error" class="load" role="progressbar" :aria-valuenow="Math.round((progress ?? 0) * 100)" aria-valuemin="0" aria-valuemax="100">
        <i :style="{ width: Math.round((progress ?? 0) * 100) + '%' }"></i>
        <span>{{ Math.round((progress ?? 0) * 100) }} %</span>
      </div>
    </form>
  </div>
</template>

<style scoped>
.splash {
  position: absolute;
  inset: 0;
  z-index: 10;
  overflow: hidden;
  background: var(--ink);
}
.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 40%;
}

/* start desk: a slim bar along the bottom */
.desk {
  position: absolute;
  left: 50%;
  bottom: 3vh;
  display: grid;
  gap: 8px;
  padding: 12px 20px;
  transform: translateX(-50%) rotate(-1deg);
  font-size: clamp(13px, 1.15vw, 18px);
  white-space: nowrap;
}
.line {
  display: flex;
  align-items: center;
  gap: 14px;
}
.desk label,
.desk h2 {
  margin: 0;
  color: var(--gold);
  font-family: var(--comic);
  font-size: 1.5em;
  font-weight: 400;
  letter-spacing: 0.06em;
}
.desk input {
  width: 13em;
  padding: 0.35em 0.6em;
  color: var(--ink);
  background: var(--paper);
  border: 3px solid var(--ink);
  border-radius: 8px;
  font: inherit;
  font-size: 1.15em;
  font-weight: 700;
}
.desk p {
  margin: 0;
  opacity: 0.9;
}
@media (max-width: 760px), (max-height: 480px) {
  .desk {
    bottom: 1.5vh;
    width: 92vw;
    padding: 8px 12px;
    font-size: 12px;
    white-space: normal;
  }
  .line {
    flex-wrap: wrap;
    gap: 6px 10px;
  }
  .desk input {
    width: 9em;
  }
}
.load {
  position: relative;
  height: 18px;
  background: var(--ink);
  border: 3px solid var(--ink);
  border-radius: 9px;
  box-shadow: 0 0 0 2px var(--hot);
  overflow: hidden;
}
.load i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--sun), var(--gold));
  border-radius: 6px;
  transition: width 0.25s;
}
.load span {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--paper);
  font-family: var(--comic);
  font-size: 0.9em;
  letter-spacing: 0.06em;
  text-shadow: 0 1px 2px var(--ink), 0 0 3px var(--ink);
}
.desk .error {
  color: #ff9a8a;
  white-space: normal;
}
.desk ol {
  display: flex;
  gap: 1.6em;
  margin: 0;
  padding: 0;
  list-style: none;
  font-variant-numeric: tabular-nums;
}
.desk li {
  display: flex;
  gap: 0.45em;
}
.desk li:first-child b {
  color: var(--gold);
}
.desk em {
  font-style: normal;
  opacity: 0.85;
}
</style>
