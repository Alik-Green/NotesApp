/**
 * Dependency-free base64 for typed arrays. Deliberately avoids `btoa`/`Buffer` so `src/core`
 * stays free of both DOM globals and Node APIs.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < CHARS.length; i++) table[CHARS.charCodeAt(i)] = i;
  return table;
})();

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : CHARS[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : CHARS[b2 & 63];
  }
  return out;
}

export function base64ToBytes(input: string): Uint8Array {
  let len = input.length;
  while (len > 0 && input.charCodeAt(len - 1) === 61 /* '=' */) len--;
  const byteLength = Math.floor((len * 3) / 4);
  const out = new Uint8Array(byteLength);
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < len; i++) {
    const value = LOOKUP[input.charCodeAt(i)] ?? -1;
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return index === byteLength ? out : out.subarray(0, index);
}

/** Int16Array ↔ base64 (little-endian). */
export function int16ToBase64(arr: Int16Array): string {
  return bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

export function base64ToInt16(str: string): Int16Array {
  const bytes = base64ToBytes(str);
  const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}

export function uint8ToBase64(arr: Uint8Array): string {
  return bytesToBase64(arr);
}

export function base64ToUint8(str: string): Uint8Array {
  return base64ToBytes(str);
}
