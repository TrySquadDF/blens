```ts
import * as b from "@trysquaddf/blens";

// Transport metadata stays outside the packet schema.
const CHANNEL_ID = 0x08;

// Compile once at module scope to reuse offsets and reference checks for every packet.
export const ExamplePacket = b.struct({
  size: 22, // Head: 6 bytes; body: 10 bytes; tail: 6 bytes.

  // Offsets are computed from field sizes, including reserved bytes.
  head: [
    ['command', b.u8],
    ['status', b.u8],
    b.skip(1),
    ['address', b.u16.be], // Multi-byte integers require an explicit byte order.
    ['dataLength', b.u8],
  ],

  // Encoding fills dataLength with the actual payload length.
  body: b.data({ lengthField: 'dataLength', maxLength: 10 }),

  tail: [
    b.skip(5),
    ['crc', b.u8],
  ],

  // The callback receives a packet copy with zeroed checksum bytes.
  // This sum can include those zeros. CRC algorithms that require exclusion
  // can use the second callback argument, { offset, size }, to skip the field.
  checksum: {
    field: 'crc',
    calculate: (buffer) => {
      let crcSum = CHANNEL_ID; // Include transport metadata in the checksum.
      for (const byte of buffer) crcSum += byte;
      return (0x55 - (crcSum & 0xFF)) & 0xFF;
    }
  }
});

// Body is optional. Computed length and checksum fields can be omitted.
const bytes = ExamplePacket.encode({
  head: { command: 0x01, status: 0, address: 0x1a2b },
  body: new Uint8Array([0xde, 0xad]),
});

await transport.send(CHANNEL_ID, bytes);
```
