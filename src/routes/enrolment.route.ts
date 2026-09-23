import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Config } from '../config';
import { LAUNCH_EMAIL_MISSING_MESSAGE, sendError } from '../errors';
import { ltiContextId } from '../lti-claims';
import UnitLink from '../schema/unitLink.model';

export const EnrolmentRouter = express.Router();

/*
 * Enrols an LMS user into the linked OnTrack Unit
 */
EnrolmentRouter.post('/enrolments', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid token', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  // Has our context been linked to an OnTrack unit?
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return sendError(res, 'Unit link not found', 404);
  }

  const members = await launchContext.namesAndRoles.getMembers();
  if (!members) {
    return res.status(400);
  }

  const newToken = {
    purpose: 'enrol_bulk',
    unit_id: link?.unitId,
    members: members.members,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.API_HOST}/api/lti/enrol/bulk`, {
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
    return sendError(res, errorBody, response.status);
  }

  const data = await response.json();

  res.json(data);
});

/*
 * Enrols a list of LMS users into the linked OnTrack Unit
 */
EnrolmentRouter.post('/enrol', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid token', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  // Has our context been linked to an OnTrack unit?
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return sendError(res, 'Unit link not found', 404);
  }

  const members = await launchContext.namesAndRoles.getMembers();
  if (!members) {
    return sendError(res, 'Could not retrieve member information', 404);
  }

  const member = members.members.find((m) => m.userId === launchContext.idToken.user.id);

  if (!launchContext.idToken.user.email) {
    return sendError(res, LAUNCH_EMAIL_MISSING_MESSAGE, 422);
  }

  const newToken = {
    purpose: 'enrol',
    unit_id: link?.unitId,
    member: member,
    email: launchContext.idToken.user.email,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.API_HOST}/api/lti/enrol`, {
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

  if (response.status === 204) {
    return sendError(res, 'Unable to enrol, user must only have student roles.', 204);
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return sendError(res, errorBody, response.status);
  }

  const data = await response.json();

  res.json(data);
});
