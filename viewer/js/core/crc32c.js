// CRC-32C (Castagnoli), the checksum the streamable .nxs4 profile uses for its
// superblock, chunk index records and payloads.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; ++i) {
    let c = i;
    for (let k = 0; k < 8; ++k) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32c(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; ++i) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
