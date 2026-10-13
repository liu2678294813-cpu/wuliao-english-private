// Backup v1 remains restorable by the existing importer. Only the update writer
// streams its JSON and binary attachments, so the WebView never builds a second
// complete account backup containing every base64 attachment.
const K = [], INITIAL = [];
for (let n = 2; K.length < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
  if (prime) {
    if (INITIAL.length < 8) INITIAL.push((Math.sqrt(n) % 1 * 0x100000000) | 0);
    K.push((Math.cbrt(n) % 1 * 0x100000000) | 0);
  }
}
const rotate = (x, n) => (x >>> n) | (x << (32 - n));

export class UpdateBackupHash {
  constructor() { this.h = [...INITIAL]; this.block = new Uint8Array(64); this.used = 0; this.length = 0; this.words = new Int32Array(64); }
  compress(bytes, offset = 0) {
    const w = this.words, view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      w[i] = (w[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + w[i - 7] + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) | 0;
    }
    let [a, b, c, d, e, f, g, j] = this.h;
    for (let i = 0; i < 64; i++) {
      const t1 = (j + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      j = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, j].forEach((v, i) => { this.h[i] = (this.h[i] + v) | 0; });
  }
  update(bytes) {
    this.length += bytes.length;
    let offset = 0;
    if (this.used) {
      const take = Math.min(64 - this.used, bytes.length);
      this.block.set(bytes.subarray(0, take), this.used); this.used += take; offset += take;
      if (this.used === 64) { this.compress(this.block); this.used = 0; }
    }
    while (offset + 64 <= bytes.length) { this.compress(bytes, offset); offset += 64; }
    if (offset < bytes.length) { this.block.set(bytes.subarray(offset), 0); this.used = bytes.length - offset; }
    return this;
  }
  hex() {
    const tail = new Uint8Array(this.used < 56 ? 64 : 128);
    tail.set(this.block.subarray(0, this.used)); tail[this.used] = 128;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(this.length / 0x20000000));
    view.setUint32(tail.length - 4, this.length * 8);
    for (let offset = 0; offset < tail.length; offset += 64) this.compress(tail, offset);
    return this.h.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('');
  }
  copy() {
    const result = new UpdateBackupHash();
    result.h = [...this.h]; result.block.set(this.block); result.used = this.used; result.length = this.length;
    return result;
  }
}

const BLOB_CHUNK = 96 * 1024; // Multiple of 3: concatenated base64 stays valid.
const WRITE_CHUNK = 192 * 1024;
export function updateBackupBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return btoa(binary);
}
export async function hashUpdateAttachment(blob, active) {
  const hash = new UpdateBackupHash();
  for (let offset = 0; offset < blob.size; offset += BLOB_CHUNK) {
    active(); hash.update(new Uint8Array(await blob.slice(offset, offset + BLOB_CHUNK).arrayBuffer()));
  }
  return { data: '', size: blob.size, sha256: hash.hex() };
}

async function* jsonPieces(value, blobs, active, path = []) {
  if (path.length === 3 && path[0] === 'attachments' && path[2] === 'data' && blobs.has(path[1])) {
    const blob = blobs.get(path[1]);
    yield '"';
    for (let offset = 0; offset < blob.size; offset += BLOB_CHUNK) {
      active();
      yield updateBackupBase64(new Uint8Array(await blob.slice(offset, offset + BLOB_CHUNK).arrayBuffer()));
    }
    yield '"';
  } else if (typeof value === 'string') {
    yield '"';
    for (let start = 0; start < value.length;) {
      active();
      let end = Math.min(start + 8192, value.length);
      const last = value.charCodeAt(end - 1), next = value.charCodeAt(end);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
      yield JSON.stringify(value.slice(start, end)).slice(1, -1);
      start = end;
    }
    yield '"';
  } else if (value && typeof value.toJSON === 'function') {
    yield* jsonPieces(value.toJSON(path[path.length - 1] ?? ''), blobs, active, path);
  } else if (Array.isArray(value)) {
    yield '[';
    for (let i = 0; i < value.length; i++) { if (i) yield ','; yield* jsonPieces(value[i] ?? null, blobs, active, [...path, i]); }
    yield ']';
  } else if (value && typeof value === 'object') {
    yield '{'; let first = true;
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      if (!first) yield ','; first = false;
      yield JSON.stringify(key) + ':';
      yield* jsonPieces(value[key], blobs, active, [...path, key]);
    }
    yield '}';
  } else { yield JSON.stringify(value); }
}

export async function writeStreamedUpdateBackup({ manifest, blobs, plugin, backupId, accountIndex, active }) {
  const { checksum: _unused, ...canonical } = manifest;
  const encoder = new TextEncoder(), fileHash = new UpdateBackupHash();
  const buffer = new Uint8Array(WRITE_CHUNK);
  let used = 0, offset = 0;
  const flush = async () => {
    if (!used) return;
    active();
    await plugin.writeBackupChunk({ backupId, accountIndex, offset, data: updateBackupBase64(buffer.subarray(0, used)) });
    offset += used; used = 0;
  };
  const write = async text => {
    const bytes = encoder.encode(text);
    fileHash.update(bytes);
    for (let position = 0; position < bytes.length;) {
      const take = Math.min(buffer.length - used, bytes.length - position);
      buffer.set(bytes.subarray(position, position + take), used); used += take; position += take;
      if (used === buffer.length) await flush();
    }
  };
  // Delay the final token so checksum is computed over canonical JSON, then
  // inserted as the last field without materializing that JSON in the WebView.
  let previous;
  for await (const piece of jsonPieces(canonical, blobs, active)) { if (previous !== undefined) await write(previous); previous = piece; }
  if (previous !== '}') throw new Error('更新备份结构无效');
  const canonicalHash = fileHash.copy().update(encoder.encode('}'));
  await write(',"checksum":' + JSON.stringify(canonicalHash.hex()) + '}');
  await flush(); active();
  const result = await plugin.finishBackupAccount({ backupId, accountIndex, sha256: fileHash.hex() });
  if (!result?.verified) throw new Error('本机备份未通过校验，已停止安装');
}
