export type PacketErrorCode =
  | 'INVALID_INPUT'
  | 'UNEXPECTED_BODY'
  | 'MISSING_BLOCK'
  | 'MISSING_FIELD'
  | 'INVALID_FIELD'
  | 'INVALID_BODY'
  | 'SIZE_MISMATCH'
  | 'MAGIC_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'CHECKSUM_FAILED'
  | 'INVALID_CHECKSUM'
  | 'VALIDATION_ERROR';

export interface PacketIssue {
  readonly code: PacketErrorCode;
  readonly message: string;
  readonly path?: readonly string[];
  readonly offset?: number;
  readonly expected?: unknown;
  readonly actual?: unknown;
}

export class PacketValidationError extends Error {
  /** Human-readable messages retained for compatibility. */
  readonly issues: string[];
  /** Stable codes and locations for programmatic error handling. */
  readonly details: readonly PacketIssue[];

  constructor(issues: readonly string[] | readonly PacketIssue[], options?: { cause?: unknown }) {
    const details = issues.map((issue): PacketIssue => typeof issue === 'string'
      ? { code: 'VALIDATION_ERROR', message: issue }
      : { ...issue, ...(issue.path ? { path: Object.freeze([...issue.path]) } : {}) });
    super(details.map(issue => issue.message).join('; '), options);
    this.name = 'PacketValidationError';
    this.issues = details.map(issue => issue.message);
    this.details = Object.freeze(details.map(issue => Object.freeze(issue)));
  }
}

export function validationError(
  code: PacketErrorCode,
  message: string,
  location: Omit<PacketIssue, 'code' | 'message'> = {},
): PacketValidationError {
  return new PacketValidationError([{ code, message, ...location }]);
}

export function contextualError(
  cause: unknown,
  code: PacketErrorCode,
  location: Omit<PacketIssue, 'code' | 'message'> = {},
): PacketValidationError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new PacketValidationError([{ code, message, ...location }], { cause });
}

export const toValidationError = (error: unknown): PacketValidationError =>
  error instanceof PacketValidationError ? error : contextualError(error, 'VALIDATION_ERROR');
