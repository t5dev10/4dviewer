#!/usr/bin/env python3
"""Pack a monolithic .nx4d into the streamable .nxs4 profile.

  python tools/nx4d_to_nxs4.py scene.nx4d scene.nxs4 [--audio track.ogg] [--credit "…"]
         [--coarse 0.08] [--chunk 32768] [--up z]

Layout written (all little-endian):
  u32 magic "NXs4" | u16 major 1 | u16 minor 0 | u32 header_len | JSON header (padded to 4)
  superblock: u64 chunk_index_offset | u32 chunk_count | u32 0 | u64 audio_index_offset
              | u32 audio_track_count | u32 crc32c(file[0 .. this field))
  chunk index: 64 B per chunk (offset, length, splat count, AABB, alive interval,
               lod layer, SH depth, flags, crc32c)
  chunk payloads: gzip(u32 ids[n] | f32 geo[n][16] | f16 sht[n][sh_f][(depth+1)^2][3])
  audio index + audio payloads at the end of the file.

Layer 0 (coarse) chunks come first: a subset of the most important splats with
DC colour only, so the scene paints before the full-detail chunks arrive.
Layer 1 covers every splat exactly once.
"""
import argparse
import gzip
import json
import os
import struct
import sys

import numpy as np

MAGIC_NX4D = 0x3464584E
MAGIC_NXS4 = 0x3473584E
ALPHA_CUT = 1.0 / 255.0


def crc32c_table():
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (0x82F63B78 ^ (c >> 1)) if c & 1 else c >> 1
        t.append(c)
    return t


TABLE = crc32c_table()


def crc32c_slow(data):
    c = 0xFFFFFFFF
    t = TABLE
    for b in data:
        c = t[(c ^ b) & 0xFF] ^ (c >> 8)
    return c ^ 0xFFFFFFFF


def _gf2_times(mat, vec):
    s, i = 0, 0
    while vec:
        if vec & 1:
            s ^= mat[i]
        vec >>= 1
        i += 1
    return s


def _gf2_square(mat):
    return [_gf2_times(mat, m) for m in mat]


def _shift_operator(nbytes):
    """GF(2) operator appending `nbytes` zero bytes to a CRC (zlib's crc32_combine)."""
    op = [0x82F63B78] + [1 << i for i in range(31)]  # one zero bit
    op = _gf2_square(op)  # 2 bits
    op = _gf2_square(op)  # 4 bits
    op = _gf2_square(op)  # 1 byte
    result = None
    while nbytes:
        if nbytes & 1:
            result = op if result is None else [_gf2_times(op, r) for r in result]
        nbytes >>= 1
        if nbytes:
            op = _gf2_square(op)
    return result


def crc32c(data, lanes=1024):
    """CRC-32C; large inputs run lane-parallel in numpy and are combined."""
    n = len(data)
    if n < 1 << 16:
        return crc32c_slow(data)
    blk = n // lanes
    arr = np.frombuffer(data, np.uint8, lanes * blk).reshape(lanes, blk)
    table = np.array(TABLE, np.uint32)
    c = np.full(lanes, 0xFFFFFFFF, np.uint32)
    for j in range(blk):
        c = table[(c ^ arr[:, j]) & 0xFF] ^ (c >> np.uint32(8))
    parts = (c ^ np.uint32(0xFFFFFFFF)).tolist()
    op = _shift_operator(blk)
    crc = parts[0]
    for p in parts[1:]:
        crc = _gf2_times(op, crc) ^ p
    tail = data[lanes * blk:]
    if tail:
        crc = _gf2_times(_shift_operator(len(tail)), crc) ^ crc32c_slow(tail)
    return crc


def read_nx4d(path):
    raw = gzip.decompress(open(path, 'rb').read())
    magic, hlen = struct.unpack_from('<II', raw, 0)
    if magic != MAGIC_NX4D:
        sys.exit(f'{path}: not an nx4d file')
    header = json.loads(raw[8:8 + hlen])
    n, F, L = header['count'], header['sh_f'], header['sh_l']
    B = (L + 1) ** 2
    o = 8 + hlen
    geo = np.frombuffer(raw, '<f4', n * 16, o).reshape(n, 16).copy()
    o += n * 64
    sht = np.frombuffer(raw, '<u2', n * F * B * 3, o).reshape(n, F, B, 3).copy()
    return header, geo, sht


def morton(p):
    lo, hi = p.min(0), p.max(0)
    q = ((p - lo) / np.maximum(hi - lo, 1e-9) * 1023).astype(np.uint64)

    def spread(v):
        v = (v | (v << 16)) & 0x030000FF
        v = (v | (v << 8)) & 0x0300F00F
        v = (v | (v << 4)) & 0x030C30C3
        v = (v | (v << 2)) & 0x09249249
        return v
    return spread(q[:, 0]) | (spread(q[:, 1]) << 1) | (spread(q[:, 2]) << 2)


def alive_intervals(geo, T):
    mu_t, tau, op = geo[:, 3].astype(np.float64), geo[:, 7].astype(np.float64), geo[:, 14].astype(np.float64)
    static = (tau > 0) & (np.sqrt(0.5 / np.maximum(tau, 1e-30)) > 0.6 * T)
    tau_safe = np.maximum(tau, 1e-30)
    reach = np.where(op * 255 > 1, np.sqrt(np.log(np.maximum(op * 255, 1.0)) / tau_safe), 0.0)
    reach = np.where(tau > 0, reach, np.inf)  # tau == 0: gate is exp(0) = 1 forever
    t0 = np.clip(mu_t - reach, 0, T)
    t1 = np.clip(mu_t + reach, 0, T)
    t0 = np.where(static, 0.0, t0)
    t1 = np.where(static, T, t1)
    return t0.astype(np.float32), t1.astype(np.float32)


def chunk_records(ids, geo, t0, t1):
    g = geo[ids]
    a, b = t0[ids].astype(np.float64), t1[ids].astype(np.float64)
    mu, v, mt = g[:, 0:3].astype(np.float64), g[:, 4:7].astype(np.float64), g[:, 3:4].astype(np.float64)
    pa = mu + v * (a[:, None] - mt)
    pb = mu + v * (b[:, None] - mt)
    sig = 3 * np.sqrt(np.maximum(g[:, [8, 11, 13]].astype(np.float64), 0).max(1))[:, None]
    lo = np.minimum(pa, pb) - sig
    hi = np.maximum(pa, pb) + sig
    return lo.min(0), hi.max(0), float(a.min()), float(b.max())


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--coarse', type=float, default=0.08, help='fraction of splats in the coarse layer')
    ap.add_argument('--chunk', type=int, default=32768, help='splats per full-detail chunk')
    ap.add_argument('--audio', action='append', default=[], help='audio file (any codec the browser decodes)')
    ap.add_argument('--credit', default=None)
    ap.add_argument('--up', choices=['y', 'z'], default=None)
    ap.add_argument('--level', type=int, default=6, help='gzip level')
    args = ap.parse_args()

    header, geo, sht = read_nx4d(args.src)
    n, T, F, L = header['count'], float(header['duration']), header['sh_f'], header['sh_l']
    B = (L + 1) ** 2
    t0, t1 = alive_intervals(geo, T)

    # Full-detail layer: time bins by alive-interval centre, Morton order inside.
    centre = (t0 + t1) / 2
    span = t1 - t0
    longlived = span >= 0.9 * T
    bins = np.where(longlived, -1, np.floor(centre / max(T / 24, 1e-6)).astype(np.int64))
    order = np.lexsort((morton(geo[:, :3].astype(np.float64)), bins))
    fine = [order[i:i + args.chunk] for i in range(0, n, args.chunk)]

    # Coarse layer: the most important splats (opacity x size), DC only.
    weight = geo[:, 14] * (geo[:, 8] + geo[:, 11] + geo[:, 13])
    k = max(1, int(n * args.coarse))
    coarse_ids = np.argsort(-weight)[:k]
    coarse_ids = coarse_ids[np.argsort(morton(geo[coarse_ids, :3].astype(np.float64)))]
    coarse = [coarse_ids[i:i + args.chunk] for i in range(0, len(coarse_ids), args.chunk)]

    chunks = [(0, 0, c) for c in coarse] + [(1, L, c) for c in fine]
    payloads, recs = [], []
    for layer, depth, ids in chunks:
        ids = np.sort(ids).astype('<u4')
        bands = (depth + 1) ** 2
        body = ids.tobytes() + geo[ids].astype('<f4').tobytes() + sht[ids][:, :, :bands, :].astype('<u2').tobytes()
        blob = gzip.compress(body, compresslevel=args.level, mtime=0)
        lo, hi, a, b = chunk_records(ids, geo, t0, t1)
        payloads.append(blob)
        recs.append(dict(n=len(ids), lo=lo, hi=hi, a=a, b=b, layer=layer, depth=depth, crc=crc32c(blob)))
        print(f'  chunk {len(recs) - 1:4d}: layer {layer} n={len(ids):6d} alive [{a:6.2f}, {b:6.2f}] s  {len(blob) / 1e6:6.2f} MB', file=sys.stderr)

    hdr = {
        'count_total': n, 'duration': T, 'sh_l': L, 'sh_f': F, 'chunk_codec': 'gzip', 'profile': 'f32f16',
        'coarse_chunk_count': len(coarse), 'layer_count': 2,
    }
    if args.up:
        hdr['up'] = args.up
    if header.get('view'):
        hdr['view'] = header['view']
    if args.credit:
        hdr['credit'] = args.credit
    audio_blobs = [open(p, 'rb').read() for p in args.audio]
    if audio_blobs:
        hdr['audio'] = {'tracks': [{'kind': 'bed'} for _ in audio_blobs]}
    hjson = json.dumps(hdr, separators=(',', ':')).encode()
    sb_at = 12 + ((len(hjson) + 3) & ~3)
    index_at = sb_at + 32
    data_at = index_at + 64 * len(recs)
    offsets, cur = [], data_at
    for p in payloads:
        offsets.append(cur)
        cur += len(p)

    audio_index_at = cur if audio_blobs else 0
    audio_index = b''
    if audio_blobs:
        a_data_at = audio_index_at + sum(20 + 28 for _ in audio_blobs)
        tracks, pos = [], a_data_at
        for blob, path in zip(audio_blobs, args.audio):
            ext = os.path.splitext(path)[1].lower().lstrip('.')[:4].ljust(4)
            rec = struct.pack('<QIffII', pos, len(blob), 0.0, T, crc32c(blob), 0)
            tracks.append(struct.pack('<4sHHII', ext.encode(), 2, 0, 0, 1) + struct.pack('<I', crc32c(rec)) + rec)
            pos += len(blob)
        audio_index = b''.join(tracks)

    out = bytearray()
    out += struct.pack('<IHHI', MAGIC_NXS4, 1, 0, len(hjson)) + hjson
    out += b'\0' * (sb_at - len(out))
    sb = struct.pack('<QII', index_at, len(recs), 0) + struct.pack('<QI', audio_index_at, len(audio_blobs))
    out += sb
    out += struct.pack('<I', crc32c(bytes(out)))
    for r, off, p in zip(recs, offsets, payloads):
        rec = struct.pack('<QII3f3fffBBBBI', off, len(p), r['n'], *r['lo'], *r['hi'], r['a'], r['b'],
                          r['layer'], r['depth'], 0, 0, r['crc'])
        out += rec + b'\0' * (64 - len(rec))
    for p in payloads:
        out += p
    out += audio_index
    for blob in audio_blobs:
        out += blob
    with open(args.dst, 'wb') as f:
        f.write(out)
    print(f'wrote {args.dst}: {n} splats, {len(coarse)} coarse + {len(fine)} full chunks, '
          f'{len(audio_blobs)} audio track(s), {len(out) / 1e6:.1f} MB', file=sys.stderr)


if __name__ == '__main__':
    main()
