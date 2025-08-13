import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Provider as lti } from 'ltijs';
import { Config } from '../config';
import UnitLink from '../schema/unitLink.model';
import { LtiLaunchPayload } from '../types';

export const EnrolmentRouter = express.Router();

/*
 * Enrols an LMS user into the linked OnTrack Unit
 */
EnrolmentRouter.post('/enrolments', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  // Has our context been linked to an OnTrack unit?
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).json({ error: 'Unit link not found' });
  }

  if (!_token) {
    return res.status(400);
  }

  const members = await lti.NamesAndRoles.getMembers(_token);
  if (!members) {
    return res.status(400);
  }

  const newToken = {
    unit_id: link?.unitId,
    members: members.members,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.HOST}/api/lti/enrol/bulk`, {
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

  const data = await response.json();

  res.json(data);
});

/*
 * Enrols a list of LMS users into the linked OnTrack Unit
 */
EnrolmentRouter.post('/enrol', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  // Has our context been linked to an OnTrack unit?
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).json({ error: 'Unit link not found' });
  }

  const members = await lti.NamesAndRoles.getMembers(_token!);
  if (!members) {
    return res.status(404).json({ error: 'Could not retrieve member information' });
  }
  const member = members.members.find((m) => m.user_id === token.user);

  const newToken = {
    unit_id: link?.unitId,
    member: member,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.HOST}/api/lti/enrol`, {
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

  const data = await response.json();

  res.json(data);
});
