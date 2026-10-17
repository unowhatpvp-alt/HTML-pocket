export const ENGINE_VERSION = '3.8.1';
export const ENGINE_BASE = `https://cdn.jsdelivr.net/npm/@wllama/wllama@${ENGINE_VERSION}`;
export const PREFS_KEY = 'mono.gguf.preferences.v1';
export const HISTORY_KEY = 'mono.gguf.history.v1';
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const i = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i > 1 ? 2 : 0)} ${['B','KiB','MiB','GiB','TiB'][i]}`;
}
export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
export function numeric(value, label, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const n = String(value).trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`${label}: ${value}`);
  return n;
}

/* Read only metadata windows, never allocate an ArrayBuffer the size of a model. */
class GGUFReader {
  constructor(file) { this.file = file; this.offset = 0; this.start = 0; this.buffer = new ArrayBuffer(0); }
  async take(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.file.size) throw new Error('GGUF_TRUNCATED');
    if (this.offset < this.start || this.offset + length > this.start + this.buffer.byteLength) {
      this.start = this.offset;
      this.buffer = await this.file.slice(this.offset, Math.min(this.file.size, this.offset + Math.max(length, 262144))).arrayBuffer();
    }
    const out = new DataView(this.buffer, this.offset - this.start, length); this.offset += length; return out;
  }
  skip(length) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.file.size) throw new Error('GGUF_TRUNCATED');
    this.offset += length;
  }
  async u32() { return (await this.take(4)).getUint32(0, true); }
  async u64() { const n = (await this.take(8)).getBigUint64(0, true); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GGUF_INVALID_COUNT'); return Number(n); }
  async string(keep = true) {
    const n = await this.u64();
    if (!keep) { this.skip(n); return; }
    if (n > 8 * 1024 * 1024) throw new Error('GGUF_METADATA_TOO_LARGE');
    const view = await this.take(n); return new TextDecoder().decode(new Uint8Array(view.buffer, view.byteOffset, n));
  }
  async value(type, keep, depth = 0) {
    const sizes = [1,1,2,2,4,4,4,1,0,0,8,8,8];
    if (type === 8) return this.string(keep);
    if (type === 9) {
      if (depth > 3) throw new Error('GGUF_INVALID_ARRAY');
      const subType = await this.u32(), count = await this.u64();
      if (subType >= sizes.length) throw new Error('GGUF_INVALID_TYPE');
      if (sizes[subType]) { this.skip(count * sizes[subType]); return; }
      // Strings cannot be skipped without reading each length; do not retain vocabulary strings.
      if (count > this.file.size / 8) throw new Error('GGUF_INVALID_COUNT');
      for (let i = 0; i < count; i++) await this.value(subType, false, depth + 1);
      return;
    }
    if (!sizes[type]) throw new Error('GGUF_INVALID_TYPE');
    if (!keep) { this.skip(sizes[type]); return; }
    const v = await this.take(sizes[type]);
    switch (type) {
      case 0:return v.getUint8(0); case 1:return v.getInt8(0); case 2:return v.getUint16(0,true); case 3:return v.getInt16(0,true);
      case 4:return v.getUint32(0,true); case 5:return v.getInt32(0,true); case 6:return v.getFloat32(0,true); case 7:return !!v.getUint8(0);
      case 10:return String(v.getBigUint64(0,true)); case 11:return String(v.getBigInt64(0,true)); case 12:return v.getFloat64(0,true);
    }
  }
}
export async function readGGUF(file) {
  const r = new GGUFReader(file);
  const magic = await r.take(4);
  if (magic.getUint32(0, true) !== 0x46554747) throw new Error('GGUF_BAD_MAGIC');
  const version = await r.u32(); if (![2,3].includes(version)) throw new Error(`GGUF_VERSION_${version}`);
  const tensors = await r.u64(), count = await r.u64();
  if (count > 100000) throw new Error('GGUF_INVALID_COUNT');
  const meta = {};
  for (let i = 0; i < count; i++) {
    const key = await r.string(), type = await r.u32();
    const keep = /^(general\.(name|architecture|size_label|file_type|parameter_count)|split\.(no|count)|[^.]+\.(context_length|block_count))$/.test(key);
    const value = await r.value(type, keep);
    if (keep && value !== undefined) meta[key] = value;
  }
  return { version, tensors, meta, fileSize: file.size, metadataBytes: r.offset };
}
export async function inspectFiles(files) {
  if (!files.length) throw new Error('NO_FILES');
  if (files.some(f => !/\.gguf$/i.test(f.name))) throw new Error('GGUF_EXTENSION');
  const entries = [];
  for (const file of files) entries.push({ file, info: await readGGUF(file) });
  if (entries.some(e => e.info.meta['general.architecture'] === 'clip')) throw new Error('PROJECTOR_ONLY');
  const first = entries[0].info.meta;
  const count = Number(first['split.count'] || 1);
  if (count !== entries.length) throw new Error(`SHARDS_MISSING:${count}:${entries.length}`);
  const indices = new Set();
  for (const e of entries) {
    const m = e.info.meta;
    if (m['general.architecture'] !== first['general.architecture'] || (m['general.name'] && first['general.name'] && m['general.name'] !== first['general.name']) || Number(m['split.count'] || 1) !== count) throw new Error('SHARDS_MISMATCH');
    if (count > 1) {
      const index = Number(m['split.no']);
      if (!Number.isInteger(index) || index < 0 || index >= count || indices.has(index)) throw new Error('SHARDS_MISMATCH');
      indices.add(index);
    }
  }
  entries.sort((a,b) => Number(a.info.meta['split.no'] || 0) - Number(b.info.meta['split.no'] || 0));
  // File names are normalized to metadata order because the engine also sorts named File objects.
  const ordered = count > 1 ? entries.map((e,i) => new File([e.file], `model-${String(i+1).padStart(5,'0')}-of-${String(count).padStart(5,'0')}.gguf`)) : entries.map(e=>e.file);
  return { files: ordered, originals: entries.map(e=>e.file), info: entries[0].info, totalBytes: entries.reduce((n,e)=>n+e.file.size,0) };
}
export function splitReasoning(content, explicit = '') {
  const match = content.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
  if (!match) return { content, reasoning: explicit };
  return { content: content.replace(match[0], ''), reasoning: [explicit,match[1]].filter(Boolean).join('\n') };
}
export function normalizeImport(data) {
  const list = Array.isArray(data) ? data : data?.messages;
  if (!Array.isArray(list)) throw new Error('INVALID_CHAT');
  const messages = list.map(m => {
    if (!m || !['user','assistant','system'].includes(m.role) || typeof m.content !== 'string') throw new Error('INVALID_CHAT');
    return { id: crypto.randomUUID(), role: m.role, content: m.content, reasoning: typeof m.reasoning === 'string' ? m.reasoning : '', status: 'done' };
  });
  return { id: crypto.randomUUID(), title: typeof data?.title === 'string' ? data.title.slice(0,120) : (messages.find(m=>m.role==='user')?.content.slice(0,40) || ''), messages, updated: Date.now() };
}
export function extractRuntimeStats(line, stats) {
  const offload = line.match(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers\s+to\s+GPU/i);
  if (offload) { stats.gpuLayers = Number(offload[1]); stats.totalLayers = Number(offload[2]); }
  const buffer = line.match(/(\S+)\s+(model|KV|compute)\s+buffer size\s*=\s*([\d.]+)\s*(MiB|GiB)/i);
  if (buffer) stats.buffers[`${buffer[1]} ${buffer[2]}`] = { device:buffer[1], kind:buffer[2], bytes:Number(buffer[3]) * (buffer[4].toLowerCase()==='gib'?1024**3:1024**2) };
  return stats;
}
