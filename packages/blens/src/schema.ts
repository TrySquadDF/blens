import type { DataFieldFactory, FieldDef, LayoutEntry, TypeDef } from './fields';
import type { PacketValidationError } from './errors';

type Layout = readonly LayoutEntry[];
type NamedEntry<T extends Layout> = Extract<T[number], readonly [string, TypeDef<unknown>]>;
type Fields<T extends Layout> = {
  [Entry in NamedEntry<T> as Entry[0]]: ReturnType<Entry[1]['read']>;
};
type ResolvedFields<T> = { readonly [Key in keyof T]: FieldDef<T[Key]> };

type NumericFieldNames<T extends Layout> = {
  [Key in keyof Fields<T>]: unknown extends Fields<T>[Key] ? Key
    : Fields<T>[Key] extends number ? Key : never;
}[keyof Fields<T>] & string;

export interface ChecksumConfig<TField extends string = string> {
  field: TField;
  /**
   * Receives an independent packet copy with checksum bytes zeroed.
   * Use the field position when the checksum must exclude those bytes.
   */
  calculate: (buffer: Uint8Array, field: { offset: number; size: number }) => number;
}

export interface PacketSchema<THead extends Layout = Layout, TTail extends Layout = Layout> {
  size: number;
  head?: THead;
  body?: DataFieldFactory;
  tail?: TTail;
  checksum?: ChecksumConfig<NumericFieldNames<NoInfer<THead>> | NumericFieldNames<NoInfer<TTail>>>;
}

export interface PacketCodec<TInput, TOutput, TResolvedFields extends object = object> {
  /** Fixed size of every encoded packet and accepted decode buffer. */
  readonly size: number;
  /** Field definitions with their compiled byte offsets. */
  readonly resolvedFields: TResolvedFields;
  safeEncode: (input: TInput) =>
    | { success: true; buffer: Uint8Array }
    | { success: false; error: PacketValidationError };
  encode: (input: TInput) => Uint8Array;
  safeDecode(buffer: Uint8Array):
    | { success: true; data: TOutput }
    | { success: false; error: PacketValidationError };
  decode(buffer: Uint8Array): TOutput;
}

/** Input accepted by a codec's encode method. */
export type InferInput<TCodec extends { encode(input: never): unknown }> = Parameters<TCodec['encode']>[0];
/** Output returned by a codec's decode method. */
export type InferOutput<TCodec extends { decode(buffer: Uint8Array): unknown }> = ReturnType<TCodec['decode']>;

export type EmptyPayload = Uint8Array & { readonly length: 0 };

type OptionalFields<T, TComputed extends string> =
  Omit<T, TComputed> & Partial<Pick<T, Extract<keyof T, TComputed>>>;
type InputBlock<TName extends string, TFields, TComputed extends string> =
  [Exclude<keyof TFields, TComputed>] extends [never]
    ? { [Key in TName]?: OptionalFields<TFields, TComputed> }
    : { [Key in TName]: OptionalFields<TFields, TComputed> };

// Only a single, definitely configured name can make an input field optional.
type IsUnion<T, Whole = T> = T extends unknown ? ([Whole] extends [T] ? false : true) : never;
type LiteralName<T extends string> = string extends T ? never : true extends IsUnion<T> ? never : T;
type ComputedFields<T> =
  ([T] extends [{ body: { lengthField: infer Name extends string } }] ? LiteralName<Name> : never)
  | ([T] extends [{ checksum: { field: infer Name extends string } }] ? LiteralName<Name> : never);

// A union may contain a body even when body is not one of its common keys.
type SchemaKeys<T> = T extends unknown ? keyof T : never;
type SchemaBody<T> = 'body' extends SchemaKeys<T> ? Uint8Array : EmptyPayload;

export type CompiledCodec<THead extends Layout, TTail extends Layout, TSchema> = PacketCodec<
  InputBlock<'head', Fields<THead>, ComputedFields<TSchema>>
    & { body?: SchemaBody<TSchema> }
    & InputBlock<'tail', Fields<TTail>, ComputedFields<TSchema>>,
  { head: Fields<THead>; body: SchemaBody<TSchema>; tail: Fields<TTail> },
  ResolvedFields<Fields<THead> & Fields<TTail>>
>;

// Dynamic arrays describe possible entries, so their names are checked at runtime.
type TupleNames<T extends Layout> = number extends T['length'] ? never : NamedEntry<T>[0];
type DuplicateNames<T extends Layout, Seen extends string = never, Duplicates extends string = never> =
  T extends readonly [infer Entry, ...infer Rest extends Layout]
    ? Entry extends readonly [infer Name extends string, unknown]
      ? DuplicateNames<Rest, Seen | Name, Duplicates | Extract<Name, Seen>>
      : DuplicateNames<Rest, Seen, Duplicates>
    : Duplicates;
type RejectNames<TNames, TMessage extends string> =
  [TNames] extends [never] ? unknown : { readonly [Key in TMessage]: never };

type ValidateNames<THead extends Layout, TTail extends Layout> = RejectNames<
  DuplicateNames<THead> | DuplicateNames<TTail> | Extract<TupleNames<THead>, TupleNames<TTail>>,
  'Duplicate field names'
>;

type ValidateLength<THead extends Layout, TSchema> =
  TSchema extends { body: { lengthField?: infer Name extends string } }
    ? string extends Name ? unknown
      : RejectNames<Exclude<Name, NumericFieldNames<THead>>, 'lengthField must reference a numeric field in head'>
    : unknown;

export type ValidateSchema<THead extends Layout, TTail extends Layout, TSchema> =
  ValidateNames<THead, TTail> & ValidateLength<THead, TSchema>;
