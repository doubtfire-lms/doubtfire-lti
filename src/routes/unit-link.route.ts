import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { LaunchContext } from 'ltijs';
import { Config } from '../config';
import { LAUNCH_EMAIL_MISSING_MESSAGE, sendError } from '../errors';
import { isStaffLaunch, ltiContextId } from '../lti-claims';
import UnitLink from '../schema/unitLink.model';
import {
  ensureStoredGradeLineItem,
  gradeLineItemErrorMessage,
  gradeLineItemErrorStatus,
  storedGradeLineItemStatus,
} from '../services/grade-line-item.service';
import { platformForLink, refreshLinkFromLaunch } from '../services/lms-link.service';

export const UnitLinkRouter = express.Router();

type UnitLinkAuthorisation = { ok: true } | { ok: false; status: number; error: unknown };

/*
 * Asks OnTrack whether the signed-in user may link the unit, and is the user who launched from the LMS
 */
async function authoriseUnitLink(
  req: Request,
  launchContext: LaunchContext,
  unitId: string,
): Promise<UnitLinkAuthorisation> {
  const signedToken = jwt.sign(
    {
      unit_id: unitId,
      email: launchContext.idToken.user.email,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
      jti: crypto.randomUUID(),
    },
    Config.LTI_SHARED_API_SECRET,
  );

  const response = await fetch(`${Config.API_HOST}/api/lti/link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
      Username: String(req.headers['username'] ?? ''),
    },
    body: JSON.stringify({ ltik: signedToken }),
  });

  if (response.ok) return { ok: true };
  return { ok: false, status: response.status, error: await response.json().catch(() => ({})) };
}

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
  if (!link) return res.json({ configured: false, visibility: 'unknown' });

  try {
    const platform = await platformForLink(link);
    return res.json(await storedGradeLineItemStatus(link, platform));
  } catch (error) {
    console.error('Unable to validate the linked Moodle grade item', error);
    return sendError(
      res,
      gradeLineItemErrorMessage(error, 'Unable to validate the linked Moodle grade item'),
      gradeLineItemErrorStatus(error),
    );
  }
});

/*
 * Retries finding or creating the grade line item after an LMS configuration change.
 */
UnitLinkRouter.post('/grade-line-item', async (_req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti token', 403);
  }
  if (!isStaffLaunch(launchContext.idToken.user.roles)) {
    return sendError(res, 'Only LMS staff can retry grade setup', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return sendError(res, 'No unit is linked to this course', 404);
  }

  try {
    const platform = await platformForLink(link);
    return res.json(await ensureStoredGradeLineItem(link, platform));
  } catch (error) {
    console.error('Unable to find or create the Moodle grade item', error);
    return sendError(
      res,
      gradeLineItemErrorMessage(error, 'Unable to find or create the Moodle grade item'),
      gradeLineItemErrorStatus(error),
    );
  }
});

/*
 * Links a unit to an LMS context
 */
UnitLinkRouter.post('/link', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti token', 403);
  }
  // The link decides where this course's roster is read from and its grades are sent to
  if (!isStaffLaunch(launchContext.idToken.user.roles)) {
    return sendError(res, 'Only LMS staff can link this course to an OnTrack unit', 403);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const unitId = String(req.body?.unitId ?? '');
  if (!/^[1-9]\d*$/.test(unitId)) {
    return sendError(res, 'unitId must be a positive integer', 400);
  }
  if (!launchContext.idToken.user.email) {
    return sendError(res, LAUNCH_EMAIL_MISSING_MESSAGE, 422);
  }

  const existingUnitLink = await UnitLink.findOne({ unitId });
  if (existingUnitLink && existingUnitLink.contextId !== contextId) {
    return sendError(
      res,
      'This OnTrack unit is already linked to another LMS course. Unlink it from the LMS tab in OnTrack first.',
      409,
    );
  }

  const authorisation = await authoriseUnitLink(req, launchContext, unitId);
  if (!authorisation.ok) {
    return sendError(res, authorisation.error, authorisation.status);
  }

  // Replacing a link hands the course's roster and grade column to another unit, so the user must manage both
  const currentLink = await UnitLink.findOne({ contextId });
  if (currentLink?.unitId && currentLink.unitId !== unitId) {
    const current = await authoriseUnitLink(req, launchContext, currentLink.unitId);
    // 404 means the linked unit was deleted from OnTrack, so there is nothing left to protect
    if (!current.ok && current.status !== 404) {
      return current.status === 403
        ? sendError(
            res,
            "This course is already linked to an OnTrack unit you can't manage. Ask that unit's convenor to unlink it first.",
            403,
          )
        : sendError(res, current.error, current.status);
    }
  }

  const link = await UnitLink.findOneAndUpdate(
    { contextId },
    { unitId },
    { upsert: true, new: true },
  );
  const result = await refreshLinkFromLaunch(link, launchContext, { probeCourseData: true });

  try {
    const platform = await platformForLink(result);
    await ensureStoredGradeLineItem(result, platform);
  } catch (error) {
    // Grade setup is recoverable from either OnTrack grade interface and must not block linking.
    console.error('Unable to create or resolve the Moodle grade item', error);
  }

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
  if (!isStaffLaunch(launchContext.idToken.user.roles)) {
    return sendError(res, 'Only LMS staff can unlink this course from its OnTrack unit', 403);
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
  if (!launchContext.idToken.user.email) {
    return sendError(res, LAUNCH_EMAIL_MISSING_MESSAGE, 422);
  }

  // Re-use the link check so only staff who could link this unit can unlink it
  const authorisation = await authoriseUnitLink(req, launchContext, unitId);
  if (!authorisation.ok) {
    return sendError(res, authorisation.error, authorisation.status);
  }

  await UnitLink.deleteMany({ contextId });
  res.status(204).send();
});
