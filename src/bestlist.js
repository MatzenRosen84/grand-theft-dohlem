// Best list and player name, kept in this browser's local storage.

const KEY = 'bestenliste'
const NAME_KEY = 'fahrername'
const KEEP = 20

const read = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback
  } catch {
    return fallback
  }
}
const write = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private mode: nothing is remembered */
  }
}

export const loadName = () => read(NAME_KEY, '')
export const saveName = (name) => write(NAME_KEY, name)

// entries: { name, cash, trips, reason: 'time' | 'wreck', date }
export const loadBest = () => read(KEY, []).filter((e) => e && typeof e.cash === 'number')

// adds a result and returns { list, rank } with rank counted from 1 (0 if it dropped off the end)
export function addResult(entry) {
  const stamped = { ...entry, date: new Date().toISOString().slice(0, 10), id: Date.now() }
  const list = [...loadBest(), stamped].sort((a, b) => b.cash - a.cash).slice(0, KEEP)
  write(KEY, list)
  return { list, rank: list.findIndex((e) => e.id === stamped.id) + 1 }
}
