/** Named layout storage in localStorage, separate from the working-copy
 * autosave. Values are the same JSON shape as file export/import. */
const STORAGE_KEY = 'keebforge.files.v1'

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAll(all: Record<string, unknown>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    alert('Could not save: browser storage is full or unavailable.')
  }
}

export function listFiles(): string[] {
  return Object.keys(readAll()).sort((a, b) => a.localeCompare(b))
}

export function saveFile(name: string, doc: unknown) {
  const all = readAll()
  all[name] = doc
  writeAll(all)
}

export function loadFile(name: string): unknown {
  return readAll()[name] ?? null
}

export function deleteFile(name: string) {
  const all = readAll()
  delete all[name]
  writeAll(all)
}
