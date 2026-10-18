// Local directory access only. This module never sends file contents over the network.
const DB_NAME = 'mono.gguf.folder.v1';
const STORE = 'settings';
const HANDLE_KEY = 'chat-directory';
const FORMAT = 'mono-gguf-chat';

export function createHandleStore(indexedDB) {
  async function transaction(mode, operation) {
    if (!indexedDB) throw new Error('IndexedDB unavailable');
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = operation(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error('Storage failed'));
      });
    } finally { db.close(); }
  }
  return {
    get: () => transaction('readonly', store => store.get(HANDLE_KEY)),
    set: handle => transaction('readwrite', store => store.put(handle, HANDLE_KEY)),
    clear: () => transaction('readwrite', store => store.delete(HANDLE_KEY))
  };
}

export class FolderChatStore {
  constructor({ environment = globalThis, handleStore, onChange = () => {} } = {}) {
    this.environment = environment;
    this.handleStore = handleStore || createHandleStore(environment.indexedDB);
    this.onChange = onChange;
    this.handle = null;
    this.revision = 0;
    this.pending = new Map();
    this.running = null;
    this.status = { supported: typeof environment.showDirectoryPicker === 'function', phase: 'off', name: '', remembered: true, lastSaved: null, error: '' };
  }
  emit(patch = {}) { Object.assign(this.status, patch); this.onChange({ ...this.status }); }
  get isWriting() { return !!this.running; }
  async restore() {
    if (!this.status.supported) return;
    this.emit({ phase: 'restoring' });
    try {
      this.handle = await this.handleStore.get() || null;
      if (this.handle) {
        const granted = await this.handle.queryPermission({ mode: 'readwrite' }) === 'granted';
        this.emit({ name: this.handle.name, phase: granted ? 'ready' : 'permission' });
      } else this.emit({ phase: 'off' });
    } catch { this.handle = null; this.emit({ phase: 'off', remembered: false }); }
  }
  async choose() {
    if (!this.status.supported) return false;
    // Must remain before any await: the picker requires the user's click activation.
    const handle = await this.environment.showDirectoryPicker({ id: 'mono-chat-history', mode: 'readwrite', startIn: this.handle || 'documents' });
    this.revision++;
    this.pending.clear();
    this.handle = handle;
    this.emit({ name: handle.name, phase: 'ready', lastSaved: null, error: '', remembered: true });
    try { await this.handleStore.set(handle); }
    catch { this.emit({ remembered: false }); }
    return true;
  }
  async resume() {
    if (!this.handle) return false;
    const handle = this.handle, revision = this.revision;
    // Only called from an explicit button click; never prompt in a background save.
    const granted = await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
    if (revision !== this.revision) return false;
    this.emit({ phase: granted ? 'ready' : 'permission', error: '' });
    return granted;
  }
  async disconnect() {
    this.revision++;
    this.pending.clear();
    this.handle = null;
    this.emit({ name: '', phase: 'off', lastSaved: null, error: '' });
    try { await this.handleStore.clear(); return true; }
    catch { this.emit({ remembered: false }); return false; }
  }
  save(chats) {
    if (!this.handle) return Promise.resolve(false);
    // Serialize now: later edits or switching chats must never mutate queued writes.
    for (const chat of Array.isArray(chats) ? chats : [chats]) {
      if (!chat?.messages?.length || typeof chat.id !== 'string') continue;
      this.pending.set(chat.id, JSON.stringify({ format: FORMAT, version: 1, id: chat.id, title: chat.title, updated: chat.updated, messages: chat.messages }, null, 2));
    }
    return this.drain();
  }
  drain() {
    if (this.running) return this.running.then(() => this.drain());
    if (!this.handle || !this.pending.size || !['ready', 'saved', 'saving'].includes(this.status.phase)) return Promise.resolve(false);
    const handle = this.handle, revision = this.revision;
    this.emit({ phase: 'saving', error: '' });
    this.running = (async () => {
      try {
        if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
          if (revision === this.revision) this.emit({ phase: 'permission' });
          return false;
        }
        while (this.pending.size && revision === this.revision) {
          const [id, text] = this.pending.entries().next().value;
          await this.writeChat(handle, id, text, revision);
          if (revision !== this.revision) return false;
          if (this.pending.get(id) === text) this.pending.delete(id);
          this.emit({ lastSaved: Date.now() });
        }
        if (revision === this.revision) this.emit({ phase: 'saved' });
        return true;
      } catch (error) {
        if (revision === this.revision) this.emit({ phase: error.name === 'NotAllowedError' ? 'permission' : 'error', error: error.message || String(error) });
        return false;
      }
    })().finally(() => {
      this.running = null;
      // A folder may have changed while an old write was being aborted.
      if (revision !== this.revision) this.drain();
    });
    return this.running;
  }
  async writeChat(directory, id, text, revision) {
    let suffix = id;
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) {
      const hash = await this.environment.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
      suffix = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    }
    const name = `mono-chat-${suffix}.json`;
    let file;
    try {
      file = await directory.getFileHandle(name);
      // Do not silently replace an unrelated file that happens to have this name.
      const contents = await (await file.getFile()).text();
      // An interrupted first write may leave an empty file. Retrying it loses no data.
      if (contents) {
        let existing;
        try { existing = JSON.parse(contents); } catch { throw new Error('FILE_CONFLICT'); }
        if (existing?.format !== FORMAT || existing.id !== id || existing.version !== 1) throw new Error('FILE_CONFLICT');
        const incoming = JSON.parse(text);
        if (Number.isFinite(existing.updated) && (!Number.isFinite(incoming.updated) || existing.updated > incoming.updated)) throw new Error('FILE_NEWER');
      }
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
      if (revision !== this.revision) return;
      file = await directory.getFileHandle(name, { create: true });
    }
    if (revision !== this.revision) return;
    const writable = await file.createWritable();
    try {
      await writable.write(text);
      if (revision !== this.revision) { await writable.abort(); return; }
      await writable.close(); // Only a successful close counts as a saved file.
    } catch (error) {
      try { await writable.abort(); } catch { /* The stream may already be closed. */ }
      throw error;
    }
  }
}
