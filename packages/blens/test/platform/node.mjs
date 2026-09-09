// Run after building the package. The .mjs name keeps Node checks outside Bun discovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { struct, data, u8, u32, PacketValidationError } from '@trysquaddf/blens';

const Packet = struct({
  size: 8, head: [['length', u8]],
  body: data({ lengthField: 'length', maxLength: 3 }),
  tail: [['crc', u32.le]], checksum: { field: 'crc', calculate: () => 0xfedcba98 },
});

test('built exports decode Buffer views repeatedly without mutation or aliasing', () => {
  const backing = Buffer.from([0xaa, 2, 10, 20, 0, 0x98, 0xba, 0xdc, 0xfe, 0xbb]);
  const before = Buffer.from(backing);
  const view = backing.subarray(1, 9);
  const first = Packet.decode(view);
  assert.equal(first.tail.crc, 0xfedcba98);
  assert.deepEqual(Packet.decode(view), first);
  assert.deepEqual(backing, before);
  view[1] = 99;
  assert.deepEqual([...first.body], [10, 20]);
  first.body[1] = 88;
  assert.equal(view[2], 20);
});

test('built exports accept computed inputs without placeholders', () => {
  assert.deepEqual([...Packet.encode({ body: Buffer.from([10, 20]) })], [2, 10, 20, 0, 0x98, 0xba, 0xdc, 0xfe]);
});

test('failed checksum callback restores Buffer and preserves the original error', () => {
  const boom = new Error('callback failed');
  const Broken = struct({
    size: 1, head: [['crc', u8]], checksum: { field: 'crc', calculate: () => { throw boom; } },
  });
  const buffer = Buffer.from([0x81]);
  const result = Broken.safeDecode(buffer);
  assert.equal(result.success, false);
  assert.ok(result.error instanceof PacketValidationError);
  assert.equal(result.error.cause, boom);
  assert.deepEqual([...buffer], [0x81]);
});

test('built package isolates retained and mutated checksum buffers', () => {
  const retained = [];
  const Isolated = struct({
    size: 2, head: [['command', u8]], tail: [['crc', u8]],
    checksum: { field: 'crc', calculate: snapshot => {
      assert.deepEqual([...snapshot], [7, 0]);
      retained.push(snapshot);
      snapshot.fill(255);
      return 7;
    } },
  });
  const backing = Buffer.from([0xaa, 7, 7, 0xbb]);
  const view = backing.subarray(1, 3);
  assert.equal(Isolated.decode(view).head.command, 7);
  const encoded = Isolated.encode({ head: { command: 7 } });
  retained.forEach(snapshot => snapshot.fill(0));
  assert.deepEqual([...backing], [0xaa, 7, 7, 0xbb]);
  assert.deepEqual([...encoded], [7, 7]);
});

test('built package rejects extra body bytes with structured errors', () => {
  const Header = struct({ size: 1, head: [['command', u8]] });
  const result = Header.safeEncode({ head: { command: 7 }, body: Buffer.from([9]) });
  assert.equal(result.success, false);
  assert.ok(result.error instanceof PacketValidationError);
  assert.equal(result.error.details[0].code, 'UNEXPECTED_BODY');
  assert.deepEqual(result.error.details[0].path, ['body']);
  assert.deepEqual([...Header.encode(Header.decode(Buffer.from([7])))], [7]);
});

test('built package decodes Uint8Array views from another realm without aliasing', () => {
  const backing = runInNewContext('new Uint8Array([0xaa, 2, 10, 20, 0, 0x98, 0xba, 0xdc, 0xfe, 0xbb])');
  const view = backing.subarray(1, 9);
  assert.equal(view instanceof Uint8Array, false);
  const before = [...backing];
  const decoded = Packet.decode(view);
  assert.deepEqual(decoded.head, { length: 2 });
  assert.deepEqual([...decoded.body], [10, 20]);
  assert.equal(decoded.tail.crc, 0xfedcba98);
  assert.deepEqual(Packet.safeDecode(view), { success: true, data: decoded });
  assert.deepEqual([...backing], before);
  view[1] = 99;
  assert.deepEqual([...decoded.body], [10, 20]);
  decoded.body[1] = 88;
  assert.equal(view[2], 20);
});

test('built package accepts foreign payloads in body and named data fields', () => {
  const payload = runInNewContext('new Uint8Array([0xaa, 10, 20, 0xbb]).subarray(1, 3)');
  assert.equal(payload instanceof Uint8Array, false);
  assert.deepEqual([...Packet.encode({ body: payload })], [2, 10, 20, 0, 0x98, 0xba, 0xdc, 0xfe]);
  const Named = struct({ size: 2, head: [['bytes', data({ maxLength: 2 })]] });
  assert.deepEqual([...Named.encode({ head: { bytes: payload } })], [10, 20]);
  const destination = new Uint8Array([0xaa, 0, 0, 0xbb]);
  data({ maxLength: 2 }).write(destination, 1, payload);
  assert.deepEqual([...destination], [0xaa, 10, 20, 0xbb]);
  assert.deepEqual([...payload], [10, 20]);
});

test('built package accepts only empty foreign payloads for schemas without a body', () => {
  const Header = struct({ size: 1, head: [['command', u8]] });
  const empty = runInNewContext('new Uint8Array(0)');
  assert.equal(empty instanceof Uint8Array, false);
  assert.deepEqual([...Header.encode({ head: { command: 7 }, body: empty })], [7]);
  const result = Header.safeEncode({ head: { command: 7 }, body: runInNewContext('new Uint8Array([9])') });
  assert.equal(result.success, false);
  assert.equal(result.error.details[0].code, 'UNEXPECTED_BODY');
});

test('byte validation rejects other views and spoofed Uint8Array tags', () => {
  const Single = struct({ size: 1, body: data({ maxLength: 1 }) });
  for (const expression of [
    'new Int8Array([7])',
    'new Uint8ClampedArray([7])',
    'new Uint16Array([7])',
    'new DataView(new ArrayBuffer(1))',
    '({ length: 1, 0: 7, [Symbol.toStringTag]: "Uint8Array" })',
    'Object.defineProperty(new Uint16Array([7]), Symbol.toStringTag, { value: "Uint8Array" })',
  ]) {
    const value = runInNewContext(expression);
    const decoded = Single.safeDecode(value);
    assert.equal(decoded.success, false, expression);
    assert.equal(decoded.error.details[0].code, 'INVALID_INPUT', expression);
    const encoded = Single.safeEncode({ body: value });
    assert.equal(encoded.success, false, expression);
    assert.equal(encoded.error.details[0].code, 'INVALID_BODY', expression);
  }
});
