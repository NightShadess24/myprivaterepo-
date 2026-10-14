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
// The keystream depends on the algo (both step-first, XOR the first `len` bytes
// in place; bytes past `len` are untouched, so no decode/re-encode is needed):
//   - algo <= 1: LCG `x = x*1000005 + 0x499602D3`, keystream = high byte
//   - algo 2:    xorshift32 (13/17/5) seeded `seed | 1`, keystream = low byte
//                (same PRNG as descramble algo 3; verified byte-exact). Other
//                seedings seen in the wild are tried as fallbacks, checked
//                against the image file signature.

export interface EncParams {
  seed: number;
  len: number;
  algo: number;
}

export function readEncHeaders(headers: Record<string, string>): EncParams | null {
  let seedStr: string | undefined;
  let lenStr: string | undefined;
  let algoStr: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    const lk = key.toLowerCase();
    if (lk === "x-enc-seed") seedStr = value;
    else if (lk === "x-enc-len") lenStr = value;
    else if (lk === "x-enc-algo") algoStr = value;
  }
  if (seedStr === undefined || lenStr === undefined) return null;

  const seed = Number(seedStr);
  const len = Number(lenStr);
  // seed 0 (or anything invalid) means the image is served clean.
  if (!Number.isFinite(seed) || seed <= 0) return null;
  if (!Number.isFinite(len) || len <= 0) return null;

  const algo = parseInt(algoStr ?? "", 10);
  return { seed: seed >>> 0, len: Math.floor(len), algo: Number.isFinite(algo) ? algo : 1 };
}

function xorshiftDecrypt(src: Uint8Array, state: number, len: number, highByte: boolean) {
  const bytes = src.slice();
  const end = Math.min(len, bytes.length);
  let s = state >>> 0;
  for (let i = 0; i < end; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    bytes[i]! ^= highByte ? s >>> 24 : s & 0xff;
  }
  return bytes;
}

function lcgDecrypt(src: Uint8Array, seed: number, len: number) {
  const bytes = src.slice();
  const end = Math.min(len, bytes.length);
  let x = seed >>> 0;
  for (let i = 0; i < end; i++) {
    x = (Math.imul(x, 1000005) + 0x499602d3) >>> 0;
    bytes[i]! ^= (x >>> 24) & 0xff;
  }
  return bytes;
}

export function decryptImage(data: ArrayBuffer, params: EncParams): ArrayBuffer {
  const src = new Uint8Array(data);
  if (params.algo !== 2) return lcgDecrypt(src, params.seed, params.len).buffer;
  // Algo 2 has shipped with slightly different seeding; like the Mihon source,
  // try the known variants and keep the first that decodes to a real image.
  const candidates = [
    () => xorshiftDecrypt(src, params.seed | 1, params.len, false),
    () => xorshiftDecrypt(src, params.seed, params.len, false),
    () => xorshiftDecrypt(src, params.seed | 1, params.len, true),
    () => lcgDecrypt(src, params.seed, params.len),
  ];
  let first: Uint8Array<ArrayBuffer> | undefined;
  for (const candidate of candidates) {
    const bytes = candidate();
    first ??= bytes;
    if (sniffImageMime(bytes.buffer)) return bytes.buffer;
  }
  return first!.buffer;
}

// Mime type from the file signature, or undefined when it isn't a known image.
export function sniffImageMime(data: ArrayBuffer): string | undefined {
  const b = new Uint8Array(data, 0, Math.min(12, data.byteLength));
  if (b.length < 4) return undefined;
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && // R
    b[1] === 0x49 && // I
    b[2] === 0x46 && // F
    b[3] === 0x46 && // F
    b[8] === 0x57 && // W
    b[9] === 0x45 && // E
    b[10] === 0x42 && // B
    b[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    return "image/avif"; // ISO-BMFF `ftyp` box
  }
  return undefined;
}
