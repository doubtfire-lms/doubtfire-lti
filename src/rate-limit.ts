import { Express, Request, Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Config } from './config';

function isLtiApiRequest(req: Request): boolean {
  return req.path === '/lti/api' || req.path.startsWith('/lti/api/');
}

function isLtiLaunchRequest(req: Request): boolean {
  return req.path === '/lti/api' || req.path === '/lti/api/' || req.path === '/lti/api/login';
}

function rejectRequest(message: string) {
  return (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({ error: message });
  };
}

export function installLtiRateLimits(app: Express): void {
  // Trust only loopback and private-network reverse proxies. This lets Express
  // use Caddy's X-Forwarded-For value without trusting headers supplied by a
  // client that connects directly to the LTI service.
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

  app.use(
    rateLimit({
      windowMs: Config.LTI_RATE_LIMIT_WINDOW_MS,
      limit: Config.LTI_LAUNCH_RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      identifier: 'lti-launch',
      skip: (req) => !isLtiLaunchRequest(req),
      handler: rejectRequest('Too many LTI launch attempts. Please try again later.'),
    }),
  );

  app.use(
    rateLimit({
      windowMs: Config.LTI_RATE_LIMIT_WINDOW_MS,
      limit: Config.LTI_API_RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      identifier: 'lti-api',
      skip: (req) => !isLtiApiRequest(req) || isLtiLaunchRequest(req),
      handler: rejectRequest('Too many LTI API requests. Please try again later.'),
    }),
  );
}
