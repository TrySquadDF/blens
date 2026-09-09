import { Buffer } from 'node:buffer';
import { strict as assert } from 'node:assert';
import { struct, u8, u16, u32, data, magic } from '@trysquaddf/blens';
import { bench, finish } from './harness';

const sum16 = (bytes: Uint8Array): number => {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]!) & 0xffff;
  return sum;
};
// CRC-16/CCITT-FALSE: poly=0x1021, init=0xffff, no reflection or xorout.
// Exclude checksum bytes using the public callback metadata.
const crc16 = (bytes: Uint8Array, field: { offset: number; size: number }): number => {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    if (i >= field.offset && i < field.offset + field.size) continue;
    crc ^= bytes[i]! << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
};
assert.equal(crc16(new TextEncoder().encode('123456789'), { offset: 9, size: 0 }), 0x29b1);

function makePacket(size: number, mode: 'none' | 'sum16' | 'crc16') {
  return struct({
    size,
    head: [magic(u8, 0xa5), ['cmd', u8], ['length', u16.le], ['param', u16.le]] as const,
    body: data({ lengthField: 'length', maxLength: size - 9 }),
    tail: [['seq', u8], ['crc', u16.le]] as const,
    ...(mode === 'none' ? {} : { checksum: { field: 'crc' as const, calculate: mode === 'sum16' ? sum16 : crc16 } }),
  });
}

// Consume both scalar blocks and the payload without copying or mutating fixtures.
const digestPacket = (p: ReturnType<ReturnType<typeof makePacket>['decode']>): number =>
  p.head.cmd + p.head.length + p.head.param + p.tail.seq + p.tail.crc
  + p.body.length + (p.body[0] ?? 0) + (p.body[p.body.length - 1] ?? 0);
const digestBytes = (b: Uint8Array): number =>
  b.length + b[1]! + b[2]! + b[4]! + b[6]! + b[b.length - 2]! + b[b.length - 1]!;

for (const size of [10, 64, 512, 4096]) {
  for (const mode of ['none', 'sum16', 'crc16'] as const) {
    const Packet = makePacket(size, mode);
    const inputs = Array.from({ length: 64 }, (_, i) => ({
      head: { cmd: i, length: 0, param: i * 997 },
      body: Uint8Array.from({ length: i % 3 === 0 ? 0 : i % 3 === 1 ? Math.floor((size - 9) / 2) : size - 9 }, (_, j) => (i * 17 + j) & 255),
      tail: { seq: 63 - i, crc: 0 },
    }));
    const buffers = inputs.map(input => Packet.encode(input));
    // Validate fixtures before timing so the benchmark measures successful decoding.
    inputs.forEach((input, i) => {
      const decoded = Packet.decode(buffers[i]!);
      assert.equal(decoded.head.param, input.head.param);
      assert.equal(decoded.head.length, input.body.length);
      assert.deepEqual(decoded.body, input.body);
    });
    const batch = Math.max(100, Math.floor(200_000 / size));
    const opts = { batch, warmupIters: batch * 3 };
    let cursor = 0;
    bench(`${size}B ${mode} encode`, () => digestBytes(Packet.encode(inputs[cursor++ & 63]!)), opts);
    bench(`${size}B ${mode} decode`, () => digestPacket(Packet.decode(buffers[cursor++ & 63]!)), opts);
    if (size === 64) {
      bench(`${size}B ${mode} roundtrip`, () => digestPacket(Packet.decode(Packet.encode(inputs[cursor++ & 63]!))), opts);
      const views = buffers.map(bytes => {
        const backing = Buffer.alloc(size + 8, 0xcc);
        backing.set(bytes, 3);
        return backing.subarray(3, 3 + size);
      });
      views.forEach((view, i) => {
        assert.equal(digestPacket(Packet.decode(view)), digestPacket(Packet.decode(buffers[i]!)));
        assert.deepEqual([...view], [...buffers[i]!]);
      });
      bench(`${size}B ${mode} Buffer view decode`, () => digestPacket(Packet.decode(views[cursor++ & 63]!)), opts);
    }
  }
}

const ErrorPacket = makePacket(64, 'sum16');
const valid = ErrorPacket.encode({ head: { cmd: 1, length: 0, param: 42 }, tail: { seq: 2, crc: 0 } });
for (const failure of ['size', 'magic', 'checksum'] as const) {
  const corrupt = failure === 'size' ? valid.slice(1) : valid.slice();
  if (failure !== 'size') {
    const offset = failure === 'magic' ? 0 : 4;
    corrupt[offset] = corrupt[offset]! ^ 1;
  }
  assert.equal(ErrorPacket.safeDecode(corrupt).success, false);
  bench(`64B safeDecode ${failure} failure`, () => {
    const result = ErrorPacket.safeDecode(corrupt);
    if (result.success) throw new Error('Corrupt fixture was accepted');
    return result.error.message.length;
  });
}

// DataView coerces values while blens validates them, so this compares different contracts.
const bytes = new Uint8Array(8);
const view = new DataView(bytes.buffer);
let value = 0;
bench('u32.le write+read', () => {
  value = (value + 0x9e3779b9) >>> 0;
  u32.le.write(bytes, 1, value);
  return u32.le.read(bytes, 1);
});
bench('reused DataView u32.le write+read', () => {
  value = (value + 0x9e3779b9) >>> 0;
  view.setUint32(1, value, true);
  return view.getUint32(1, true);
});

bench('struct compilation + one field read', () => {
  const codec = makePacket(64, 'sum16');
  return codec.resolvedFields.param.decode(valid);
}, { warmupIters: 5_000, batch: 2_000 });
finish();
