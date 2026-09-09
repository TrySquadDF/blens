// The intrinsic getter reads the typed array's internal type across realms.
// Calling it directly also avoids trusting a user-defined Symbol.toStringTag.
const typedArrayTag = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag,
)!.get!;

export function isUint8Array(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && typedArrayTag.call(value) === 'Uint8Array';
}
