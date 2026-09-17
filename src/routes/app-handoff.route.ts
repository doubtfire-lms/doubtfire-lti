import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Config } from '../config';
import { sendError } from '../errors';

export const AppHandoffRouter = express.Router();

interface HandoffResponse {
  username?: unknown;
  auth_token?: unknown;
  error?: unknown;
}

/*
 * Issues a one-time OnTrack login token so the embedded LTI session can open
 * OnTrack in its own top-level tab, where first-party session cookies work.
 */
AppHandoffRouter.post('/app-handoff', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid LTI token', 403);
  }

  const email = launchContext.idToken.user.email;
  if (!email) {
    return sendError(
      res,
      "Moodle is not sharing the launcher's email with OnTrack. Set 'Share launcher's email with tool' to Always.",
      422,
    );
  }

  const signedToken = jwt.sign(
    {
      purpose: 'app_handoff',
      email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
      jti: crypto.randomUUID(),
    },
    Config.LTI_SHARED_API_SECRET,
  );

  let railsResponse: globalThis.Response;
  try {
    railsResponse = await fetch(`${Config.API_HOST}/api/lti/app-handoff`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Auth-Token': String(req.headers['auth-token'] ?? ''),
        Username: String(req.headers['username'] ?? ''),
      },
      body: JSON.stringify({ ltik: signedToken }),
    });
  } catch (error) {
    console.error('Unable to request an OnTrack app handoff', error);
    return sendError(res, 'Unable to reach OnTrack to open it in a new tab', 502);
  }

  const body = (await railsResponse.json().catch(() => ({}))) as HandoffResponse;
  if (!railsResponse.ok) {
    // Rails uses 419 for expired sessions, which would make the embedded app try a refresh it cannot perform.
    if (railsResponse.status === 419) {
      return sendError(res, 'Your OnTrack session has expired. Relaunch OnTrack from Moodle.', 401);
    }
    return sendError(
      res,
      typeof body.error === 'string' ? body.error : 'Unable to open OnTrack in a new tab',
      railsResponse.status,
    );
  }

  if (typeof body.username !== 'string' || typeof body.auth_token !== 'string') {
    return sendError(res, 'OnTrack returned an invalid handoff response', 502);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.json({ username: body.username, authToken: body.auth_token });
});
