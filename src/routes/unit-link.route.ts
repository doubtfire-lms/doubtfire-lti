import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Config } from '../config';
import { sendError } from '../errors';
import { ltiContextId } from '../lti-claims';
import UnitLink from '../schema/unitLink.model';
import {
  createGradeLineItem,
  findGradeLineItem,
  findStoredGradeLineItem,
  gradeLineItemErrorStatus,
} from '../services/grade-line-item.service';

export const UnitLinkRouter = express.Router();

/*
 * Retrieves linked unit information for a context
 */
UnitLinkRouter.get('/link', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti token', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const link = await UnitLink.findOne({ contextId });
  return res.json(link);
});

/*
 * Validates the grade line item saved when the unit was linked.
 * Moodle does not expose grade-item visibility through LTI AGS.
 */
UnitLinkRouter.get('/grade-line-item', async (_req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti token', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const link = await UnitLink.findOne({ contextId });
  if (!link?.lineItemId) {
    return res.json({ configured: false, visibility: 'unknown' });
  }

  try {
    const lineItem = await findStoredGradeLineItem(launchContext, link.lineItemId);
    if (!lineItem?.id) {
      return res.json({ configured: false, visibility: 'unknown' });
    }

    return res.json({
      configured: true,
      visibility: 'unknown',
      lineItem: {
        id: lineItem.id,
        label: lineItem.label,
        scoreMaximum: lineItem.scoreMaximum,
      },
    });
  } catch (error) {
    console.error('Unable to validate the linked Moodle grade item', error);
    return sendError(
      res,
      error instanceof Error ? error.message : 'Unable to validate the linked Moodle grade item',
      gradeLineItemErrorStatus(error),
    );
  }
});

/*
 * Links a unit to an LMS context
 */
UnitLinkRouter.post('/link', async (req: Request, res: Response) => {
  const { unitId } = req.body;
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti token', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const newToken = {
    unit_id: unitId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.API_HOST}/api/lti/link`, {
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

  let lineItemId: string;
  try {
    const lineItem =
      (await findGradeLineItem(launchContext)) ?? (await createGradeLineItem(launchContext));
    if (!lineItem.id) {
      return sendError(res, 'Moodle returned a grade line item without an ID', 502);
    }
    lineItemId = lineItem.id;
  } catch (error) {
    console.error('Unable to create or resolve the Moodle grade item', error);
    return sendError(
      res,
      error instanceof Error ? error.message : 'Unable to create or resolve the Moodle grade item',
      gradeLineItemErrorStatus(error),
    );
  }

  // Current OnTrack user has permissions to enrol students into requested unit_id
  const result = await UnitLink.findOneAndUpdate(
    { contextId },
    { unitId, lineItemId },
    { upsert: true, new: true },
  );
  res.json(result);
});

/*
 * Removes link between a unit and the LMS context
 */
UnitLinkRouter.delete('/link', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti token', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    sendError(res, 'Nothing to unlink.', 400);
    return;
  }

  const unitId = link.unitId;

  if (!unitId) {
    sendError(res, 'Invalid unit.', 400);
    return;
  }

  const newToken = {
    unit_id: unitId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  // Re-use the same endpoint to check if current user has OnTrack convenor permissions
  const response = await fetch(`${Config.API_HOST}/api/lti/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Auth-Token': String(req.headers['auth-token'] ?? ''),
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

  await UnitLink.deleteMany({ contextId });
  res.status(204).send();
});
