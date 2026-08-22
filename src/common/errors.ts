export type ProviderErrorCode =
  | 'rate-limit'
  | 'not-found'
  | 'auth'
  /** The token is valid but not authorised for an SSO-protected organisation. */
  | 'sso'
  | 'network'
  | 'server';

/**
 * Every provider maps its own HTTP semantics onto these codes, so the layers above never
 * have to know whose API answered.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status?: number,
    /** Epoch seconds when the rate limit resets, for `rate-limit` errors. */
    readonly resetAt?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
