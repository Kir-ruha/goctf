const unbytes = new TextDecoder();

function g(a, b, carry) {
  const value = (a + b + carry) & 255;
  return ((value << 2) | (value >>> 6)) & 255;
}

function f(x) {
  const a = x >>> 24, b = (x >>> 16) & 255, c = (x >>> 8) & 255, d = x & 255;
  const y1 = g(a ^ b, c ^ d, 1);
  const y2 = g(c ^ d, y1, 0);
  return (g(a, y1, 0) << 24 | y1 << 16 | y2 << 8 | g(d, y2, 1)) >>> 0;
}

function fk(x, y) {
  const a = x >>> 24, b = (x >>> 16) & 255, c = (x >>> 8) & 255, d = x & 255;
  const u = y >>> 24, v = (y >>> 16) & 255, w = (y >>> 8) & 255, z = y & 255;
  const middle1 = g(a ^ b, (c ^ d) ^ u, 1);
  const middle2 = g(c ^ d, middle1 ^ v, 0);
  return (g(a, middle1 ^ w, 0) << 24 | middle1 << 16 | middle2 << 8 | g(d, middle2 ^ z, 1)) >>> 0;
}

function block(left, right, keys) {
  let x = left, y = (right ^ left) >>> 0;
  for (let round = 3; round >= 1; round--) {
    const next = (x ^ f(y ^ keys[round])) >>> 0;
    x = y;
    y = next;
  }
  const initial = (x ^ f(y ^ keys[0])) >>> 0;
  return [(initial ^ keys[4]) >>> 0, (initial ^ y ^ keys[5]) >>> 0];
}

export function decrypt(secret, cipher) {
  if (!/^[0-9a-f]+$/.test(cipher) || cipher.length % 16 || !/^[0-9a-f]{48}$/.test(secret))
    throw Error('Invalid message');
  const material = Array.from({ length: 6 }, (_, i) => parseInt(secret.slice(i * 8, i * 8 + 8), 16) >>> 0);
  let left = material[0], right = material[1], previous = material[5];
  const words = [];
  for (let i = 0; i < 6; i++) {
    const next = fk(left, (right ^ previous ^ material[i]) >>> 0);
    previous = left;
    left = right;
    right = next;
    words.push(next >>> 16, next & 65535);
  }
  const outputLeft = ((words[8] << 16 | words[9]) ^ material[2]) >>> 0;
  const outputRight = ((words[10] << 16 | words[11]) ^ material[3]) >>> 0;
  const keys = Array.from({ length: 4 }, (_, i) =>
    (((words[i] >>> 8) << 16 | (words[i] & 255) << 8) ^ outputLeft ^
      (i % 2 ? outputRight : 0) ^ material[i]) >>> 0);
  keys.push(((words[4] << 16 | words[5]) ^ outputLeft ^ outputRight ^ material[4]) >>> 0,
    ((words[6] << 16 | words[7]) ^ outputRight ^ material[5]) >>> 0);
  const output = new Uint8Array(cipher.length / 2);
  for (let offset = 0; offset < output.length; offset += 8) {
    const [left, right] = block(
      parseInt(cipher.slice(offset * 2, offset * 2 + 8), 16) >>> 0,
      parseInt(cipher.slice(offset * 2 + 8, offset * 2 + 16), 16) >>> 0, keys
    );
    for (let i = 0; i < 4; i++) {
      output[offset + i] = left >>> (24 - 8 * i);
      output[offset + 4 + i] = right >>> (24 - 8 * i);
    }
  }
  const padding = output[output.length - 1];
  if (padding < 1 || padding > 8 || !output.slice(-padding).every(byte => byte === padding))
    throw Error('Invalid message padding');
  return unbytes.decode(output.slice(0, -padding));
}
