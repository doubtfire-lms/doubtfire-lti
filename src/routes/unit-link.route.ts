import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Config } from '../config';
import UnitLink from '../schema/unitLink.model';
import { LtiLaunchPayload } from '../types';

export const UnitLinkRouter = express.Router();

/*
 * Retrieves linked unit information for a context
 */
UnitLinkRouter.get('/link', async (req: Request, res: Response) => {
  const _token = res.locals.token;

  // const contextId = req.query.contextId;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;
  const link = await UnitLink.findOne({ contextId });
  res.json(link);
});

/*
 * Links a unit to an LMS context
 */
UnitLinkRouter.post('/link', async (req: Request, res: Response) => {
  const { unitId } = req.body;
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  const newToken = {
    unit_id: unitId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.HOST}/api/lti/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
      Username: String(req.headers['username'] ?? ''),
    },
    body: JSON.stringify({
      ltik: signedToken,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return res.status(response.status).json(errorBody);
  }

  // Current OnTrack user has permissions to enrol students into requested unit_id
  const result = await UnitLink.findOneAndUpdate(
    { contextId },
    { unitId },
    { upsert: true, new: true },
  );
  res.json(result);
});

/*
 * Removes link between a unit and the LMS context
 */
UnitLinkRouter.delete('/link', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  await UnitLink.deleteMany({ contextId });
  res.status(204).send();
});
