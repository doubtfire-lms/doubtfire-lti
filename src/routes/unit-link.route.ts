import express, { Request, Response } from 'express';
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

  // TODO: validate request with our ruby API first

  // const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

  // // TODO: signedToken as a query param or an Authorization header?
  // const response = await fetch(`http://localhost:4200/api/lti/deeplink?ltik=${signedToken}`, {
  //   method: 'GET',
  //   headers: {
  //     // Authorization: String(req.headers['authorization'] ?? ''), //
  //     'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
  //     Username: String(req.headers['username'] ?? ''),
  //   },
  // });

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
