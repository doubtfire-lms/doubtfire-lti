import cookieParser from 'cookie-parser';
import { CookieOptions, Express, NextFunction, Request, Response } from 'express';
import type { LaunchContext } from 'ltijs';
import { Config } from './config';

export const LTI_SESSION_COOKIE = 'ontrack_lti_launch';

const appOrigin = new URL(Config.APP_HOST).origin;
const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const publicLtiPaths = new Set([
  '/lti/api',
  '/lti/api/',
  '/lti/api/login',
  '/lti/api/keys',
  '/lti/api/session',
]);

declare module 'express-serve-static-core' {
  interface Locals {
    launchContext?: LaunchContext;
  }
}

function isProtectedBrowserRoute(req: Request): boolean {
  return (
    req.path.startsWith('/lti/api/') &&
    !publicLtiPaths.has(req.path) &&
    // Internal routes authenticate with the shared internal key instead of a browser session.
    !req.path.startsWith('/lti/api/internal/')
  );
}

export const ltiSessionCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: Config.LTI_COOKIES_SECURE,
  sameSite: Config.LTI_COOKIES_SAMESITE,
  // Partitioned cookies still work inside the LMS iframe when browsers block third-party cookies.
  partitioned: Config.LTI_COOKIES_SECURE && Config.LTI_COOKIES_SAMESITE === 'none',
  signed: true,
  path: '/lti/api',
};

/**
 * Makes the browser-facing LTI API cookie-authenticated without exposing the
 * ltik to Angular.
 */
export function installLtiSessionMiddleware(
  app: Express,
  resolveLaunchContext: (ltik: string) => Promise<LaunchContext>,
): void {
  app.use(cookieParser(Config.LTI_KEY));

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/lti/api')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
    }

    const origin = req.get('origin');
    if (origin === appOrigin) {
      res.setHeader('Access-Control-Allow-Origin', appOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS' && req.path.startsWith('/lti/api/')) {
      if (origin !== appOrigin) return res.status(403).json({ error: 'Invalid origin' });
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Auth-Token, Content-Type, Username');
      return res.sendStatus(204);
    }

    if (isProtectedBrowserRoute(req)) {
      if (unsafeMethods.has(req.method) && origin !== appOrigin) {
        return res.status(403).json({ error: 'Invalid origin' });
      }

      const cookieToken = req.signedCookies?.[LTI_SESSION_COOKIE];
      if (typeof cookieToken !== 'string' || !cookieToken) {
        return res.status(401).json({ error: 'LTI session not found' });
      }

      try {
        // Ignore query/body/header ltik values on browser API routes. The signed,
        // HttpOnly cookie is the only accepted source after launch.
        res.locals.launchContext = await resolveLaunchContext(cookieToken);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired LTI session' });
      }
    }

    return next();
  });
}
