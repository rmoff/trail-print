// Keeps the visitor's last run and settings in this browser (IndexedDB), so a page reload
// picks up where they left off. Nothing leaves the device. Every call is best-effort:
// private windows or blocked storage just mean nothing is remembered.

const DB = 'trail-print', STORE = 'state', KEY = 'last';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function loadSaved() {
  try { return (await run('readonly', s => s.get(KEY))) || null; } catch { return null; }
}
export async function save(value) {
  try { await run('readwrite', s => s.put(value, KEY)); } catch { /* not remembered */ }
}
export async function forget() {
  try { await run('readwrite', s => s.delete(KEY)); } catch { /* nothing to forget */ }
}
