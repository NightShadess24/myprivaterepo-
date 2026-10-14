/* SPDX-License-Identifier: GPL-3.0-or-later */
/* Copyright © 2026 Inkdex */

// Comix image byte-encryption.
//
// Some page images have their first N bytes XOR'd against a PRNG keystream,
// identified by these headers:
//
//   X-Enc-Seed:  <uint32, decimal>   e.g. "3121655837"  — 0 means clean
//   X-Enc-Len:   <decimal>           leading bytes encrypted (e.g. 4096)
//   X-Enc-Algo:  <int>               keystream variant (default 1)
//
// Keystreams (all step-first, XOR the first `len` bytes; the rest is untouched):
//   - LCG `x = x*1000005 + 1234567891`, key = high byte (algo 1)
//   - xorshift32 (13/17/5) seeded `seed | 1` or `seed`, key = low or high byte
//     (algo 2 has used several of these)
// Like the Mihon extension, decode with the algo's usual keystream first and
// keep whichever candidate starts with a real image signature.

export interface EncParams {
  seed: number;
  len: number;
  algo: number;
}

export function readEncHeaders(headers: Record<string, string>): EncParams | null {
  let seedStr: string | undefined;
  let lenStr: string | undefined;
  let algoStr: string | undefined;
  for (const [key, value] of Object.entries(headers ?? {})) {
    const lk = key.toLowerCase();
    if (lk === "x-enc-seed") seedStr = value;
    else if (lk === "x-enc-len") lenStr = value;
    else if (lk === "x-enc-algo") algoStr = value;
  }
  if (seedStr === undefined || lenStr === undefined) return null;

  const seed = Number(seedStr);
  const len = Number(lenStr);
  // seed 0 (or anything invalid) means the image is served clean.
  if (!Number.isFinite(seed) || seed === 0) return null;
  if (!Number.isFinite(len) || len <= 0) return null;

  const algo = parseInt(algoStr ?? "", 10);
  return { seed: seed >>> 0, len: Math.floor(len), algo: Number.isFinite(algo) ? algo : 1 };
}

function xorLcg(src: Uint8Array, seed: number, len: number): Uint8Array {
  const out = src.slice();
  const end = Math.min(len, out.length);
  let x = seed >>> 0;
  for (let i = 0; i < end; i++) {
    x = (Math.imul(x, 1000005) + 1234567891) >>> 0;
    out[i]! ^= x >>> 24;
  }
  return out;
}

function xorXorshift(src: Uint8Array, start: number, len: number, highByte: boolean): Uint8Array {
  const out = src.slice();
  const end = Math.min(len, out.length);
  let s = start >>> 0;
  for (let i = 0; i < end; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i]! ^= highByte ? s >>> 24 : s & 0xff;
  }
  return out;
}

export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (
    bytes[0] === 0x52 && // RIFF....WEBP
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return "image/avif"; // ....ftyp (avif/heic)
  }
  return null;
}

export function decryptImage(data: ArrayBuffer, params: EncParams): ArrayBuffer {
  const src = new Uint8Array(data);
  const { seed, len, algo } = params;
  const lcg = () => xorLcg(src, seed, len);
  const xorshifts = [
    () => xorXorshift(src, seed | 1, len, false),
    () => xorXorshift(src, seed, len, false),
    () => xorXorshift(src, seed | 1, len, true),
    () => xorXorshift(src, seed, len, true),
  ];
  const candidates = algo === 2 ? [...xorshifts, lcg] : [lcg, ...xorshifts];
  let first: Uint8Array | undefined;
  for (const candidate of candidates) {
    const out = candidate();
    if (sniffImageMime(out)) return out.buffer as ArrayBuffer;
    first ??= out;
  }
  return first!.buffer as ArrayBuffer;
}
