import { AuthError } from '../../common';
import type { DeviceCode, TokenCheck } from '../../common';

/**
 * GitHub OAuth Device Flow — the only OAuth grant that needs no client secret, which is
 * what makes it usable from an extension with no backend. The client ID is public by
 * design and ships inside the bundle.
 */
const CLIENT_ID: string = (import.meta.env.WXT_GITHUB_CLIENT_ID as string | undefined) ?? '';

/**
 * `repo` is the only classic OAuth scope that opens private repositories; GitHub offers no
 * read-only variant, so its consent screen says "full control of private repositories"
 * however little of that the extension uses.
 */
const SCOPE = 'repo';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export function isConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

/** Step 1: ask GitHub for a code the user will enter. */
export async function requestDeviceCode(): Promise<DeviceCode> {
  if (!isConfigured()) {
    throw new AuthError(
      'No GitHub client ID is configured. Set WXT_GITHUB_CLIENT_ID at build time.',
      'not-configured',
    );
  }

  const response = await fetch(DEVICE_CODE_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });

  if (!response.ok) {
    throw new AuthError(`GitHub returned ${response.status}`, 'http-error');
  }

  const data = (await response.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error?: string;
    error_description?: string;
  };

  if (data.error || !data.device_code || !data.user_code) {
    throw new AuthError(
      data.error_description ?? data.error ?? 'GitHub declined the device code request',
      data.error ?? 'unknown',
    );
  }

  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri ?? 'https://github.com/login/device',
    deviceCode: data.device_code,
    expiresIn: data.expires_in ?? 900,
    interval: data.interval ?? 5,
  };
}

/**
 * Step 2: poll until the user authorises, declines, or the code expires.
 * Honours GitHub's `slow_down` backoff instruction — ignoring it gets the app blocked.
 */
export async function pollForToken(
  device: DeviceCode,
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  const deadline = Date.now() + device.expiresIn * 1000;
  let intervalMs = device.interval * 1000;

  for (;;) {
    if (options.signal?.aborted) throw new AuthError('Sign-in cancelled', 'cancelled');
    if (Date.now() > deadline) throw new AuthError('The code expired. Try again.', 'expired_token');

    await sleep(intervalMs, options.signal);

    const response = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: device.deviceCode,
        grant_type: GRANT_TYPE,
      }),
    });

    const data = (await response.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // GitHub adds 5 seconds to the required interval when it sends this.
        intervalMs += 5000;
        continue;
      case 'expired_token':
        throw new AuthError('The code expired. Try again.', 'expired_token');
      case 'access_denied':
        throw new AuthError('Sign-in was declined.', 'access_denied');
      default:
        throw new AuthError(
          data.error_description ?? data.error ?? 'Sign-in failed',
          data.error ?? 'unknown',
        );
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AuthError('Sign-in cancelled', 'cancelled'));
      },
      { once: true },
    );
  });
}

export async function verifyToken(token: string): Promise<TokenCheck> {
  let response: Response;
  try {
    response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
  } catch {
    return 'network';
  }

  const tokenWasRejected = response.status === 401 || response.status === 403;
  if (tokenWasRejected) return 'invalid';
  if (!response.ok) return 'network';

  const data = (await response.json()) as { login?: string; avatar_url?: string };
  return data.login ? { login: data.login, avatarUrl: data.avatar_url ?? null } : 'invalid';
}
