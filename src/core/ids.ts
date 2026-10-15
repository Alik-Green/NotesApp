/** Tiny id helpers. Pure — no crypto/DOM dependency, works in workers and Node. */

import type { ID } from './model';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

let counter = Math.floor(Math.random() * 36 ** 4);

/** Short, sortable-ish, collision-resistant enough id (time + counter + noise). */
export function newId(prefix = ''): ID {
  counter = (counter + 1) % 36 ** 4;
  const time = Date.now().toString(36);
  const count = counter.toString(36).padStart(4, '0');
  let noise = '';
  for (let i = 0; i < 6; i++) noise += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return `${prefix}${prefix ? '_' : ''}${time}${count}${noise}`;
}

/** Deterministic 32-bit hash — used for stroke seeds derived from point data. */
export function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32) used for pencil texture. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
