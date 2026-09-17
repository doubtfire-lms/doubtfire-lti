import jwt from 'jsonwebtoken';
import type { Platform } from 'ltijs';
import crypto from 'node:crypto';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const TOKEN_EXPIRY_MARGIN_MS = 30_000;

export class LtiServiceError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'LtiServiceError';
  }
}

interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface PlatformAccessToken {
  authorization: string;
  expiresAt: number;
}

const tokenCache = new Map<string, PlatformAccessToken>();

/** Maps an LMS status to one OnTrack can return without implying a client mistake. */
export function platformErrorStatus(status: number): number {
  return status >= 400 && status < 500 ? 422 : 502;
}

/**
 * Requests a client-credentials token for a registered platform. Unlike ltijs' launch-scoped
 * services this needs no launch, so OnTrack can call the LMS in the background.
 */
export async function getPlatformAccessToken(
  platform: Platform,
  scopes: readonly string[],
): Promise<PlatformAccessToken> {
  const scope = [...scopes].sort().join(' ');
  const cacheKey = `${platform.id}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached;

  const assertion = jwt.sign(
    {
      sub: platform.clientId,
      iss: platform.clientId,
      aud: platform.authorizationServer,
      jti: crypto.randomUUID(),
    },
    platform.keys.private,
    { algorithm: 'RS256', expiresIn: 60, keyid: platform.id },
  );

  const response = await fetch(platform.accessTokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
      scope,
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    (Partial<AccessTokenResponse> & { error?: string }) | null;
  if (!response.ok || !payload?.access_token || !payload.token_type || !payload.expires_in) {
    const reason = payload?.error ? `: ${payload.error}` : ` (${response.status})`;
    throw new LtiServiceError(
      `The LMS did not issue an access token for ${scope}${reason}`,
      platformErrorStatus(response.status),
    );
  }

  const token = {
    authorization: `${payload.token_type} ${payload.access_token}`,
    expiresAt: Date.now() + payload.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
  };
  tokenCache.set(cacheKey, token);
  return token;
}

/** Rejects stored service URLs that do not belong to the registered platform. */
export function platformUrl(value: string, platform: Platform, description: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LtiServiceError(`The stored ${description} URL is invalid`, 422);
  }
  if (url.origin !== new URL(platform.url).origin) {
    throw new LtiServiceError(
      `The stored ${description} URL does not match the registered platform origin`,
      422,
    );
  }
  return url;
}
