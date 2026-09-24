import express, { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { Config } from '../config';
import { ltiCourseUrl } from '../lti-claims';
import { lti } from '../lti-provider';
import UnitLink, { UnitLinkDocument } from '../schema/unitLink.model';
import {
  ensureStoredGradeLineItem,
  gradeLineItemErrorMessage,
  gradeLineItemErrorStatus,
  storedGradeLineItemStatus,
} from '../services/grade-line-item.service';
import { fetchLinkMembers, platformForLink, submitLinkScore } from '../services/lms-link.service';
import {
  courseDataSectionsFrom,
  fetchStoredMoodleCourseData,
} from '../services/moodle-course-data.service';
import { LtiServiceError } from '../services/platform-access.service';

export const INTERNAL_SYNC_ROUTE_PATH = '/lti/api/internal/test-members';
export const InternalSyncRoute = express.Router();

function internalRequestAuthorised(req: Request): boolean {
  return (
    !!Config.LTI_INTERNAL_SYNC_KEY && req.header('x-internal-key') === Config.LTI_INTERNAL_SYNC_KEY
  );
}

InternalSyncRoute.use('/internal', (req: Request, res: Response, next: NextFunction) => {
  if (!Config.LTI_INTERNAL_SYNC_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!internalRequestAuthorised(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
});

function sendServiceError(res: Response, event: string, error: unknown) {
  console.error(
    JSON.stringify({ event, error: error instanceof Error ? error.message : String(error) }),
  );
  return res.status(error instanceof LtiServiceError ? error.status : 502).json({
    error: error instanceof Error ? error.message : String(error),
  });
}

function sendGradeLineItemError(res: Response, event: string, error: unknown) {
  console.error(
    JSON.stringify({ event, error: error instanceof Error ? error.message : String(error) }),
  );
  return res.status(gradeLineItemErrorStatus(error)).json({
    error: gradeLineItemErrorMessage(error, 'Unable to find or create the Moodle grade item'),
  });
}

async function linkForUnit(req: Request, res: Response): Promise<UnitLinkDocument | undefined> {
  const unitId = String(req.params.unitId ?? '');
  if (!/^[1-9]\d*$/.test(unitId)) {
    res.status(400).json({ error: 'unitId must be a positive integer' });
    return undefined;
  }
  const link = await UnitLink.findOne({ unitId });
  if (!link) {
    res.status(404).json({ error: 'This unit is not linked to an LMS course' });
    return undefined;
  }
  return link;
}

InternalSyncRoute.post('/internal/test-members', async (req: Request, res: Response) => {
  const { ltik } = req.body as Record<string, unknown>;
  if (typeof ltik !== 'string' || !ltik) {
    return res.status(400).json({
      error: 'ltik must be a non-empty string',
    });
  }

  try {
    const launchContext = await lti.getLaunchContext(ltik);
    if (!launchContext.namesAndRoles.isAvailable()) {
      return res.status(422).json({
        error: 'Stored LTI context does not include an NRPS memberships URL',
      });
    }

    const members = await launchContext.namesAndRoles.getMembers({ pages: false });

    return res.json(members);
  } catch (error) {
    return sendServiceError(res, 'nrps_test_failure', error);
  }
});

/*
 * Lets OnTrack skip its scheduled LMS sync when this service cannot serve it.
 */
InternalSyncRoute.get('/internal/health', (_req: Request, res: Response) => {
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected) {
    return res.status(503).json({ error: 'The LTI service database is unavailable' });
  }
  return res.json({ ok: true });
});

/*
 * Describes the LMS course linked to a unit. The course name is refreshed from the LMS when
 * possible, falling back to the details stored at the last launch.
 */
InternalSyncRoute.get('/internal/units/:unitId/link', async (req: Request, res: Response) => {
  const link = await linkForUnit(req, res);
  if (!link) return;

  let contextError: string | undefined;
  try {
    const platform = await platformForLink(link);
    const membership = await fetchLinkMembers(link, platform, { limit: 1 });
    const { label, title } = membership.context ?? {};
    if ((label && label !== link.contextLabel) || (title && title !== link.contextTitle)) {
      link.contextLabel = label ?? link.contextLabel ?? null;
      link.contextTitle = title ?? link.contextTitle ?? null;
      await link.save();
    }
  } catch (error) {
    contextError = error instanceof Error ? error.message : String(error);
  }

  const platform = link.platformId
    ? await lti.platformManager.getPlatformById(link.platformId)
    : undefined;

  return res.json({
    linked: true,
    contextId: link.contextId,
    contextLabel: link.contextLabel ?? null,
    contextTitle: link.contextTitle ?? null,
    courseUrl: ltiCourseUrl(link.contextId) ?? null,
    platformName: platform?.name ?? null,
    platformUrl: platform?.url ?? null,
    namesAndRolesAvailable: !!link.membershipsUrl,
    courseDataAvailable: !!link.courseDataAvailable,
    gradeLineItemLinked: !!link.lineItemId,
    capabilitiesCheckedAt: link.capabilitiesCheckedAt ?? null,
    contextError: contextError ?? null,
  });
});

InternalSyncRoute.delete('/internal/units/:unitId/link', async (req: Request, res: Response) => {
  const link = await linkForUnit(req, res);
  if (!link) return;

  await link.deleteOne();
  return res.status(204).send();
});

InternalSyncRoute.get('/internal/units/:unitId/members', async (req: Request, res: Response) => {
  const link = await linkForUnit(req, res);
  if (!link) return;

  try {
    const platform = await platformForLink(link);
    return res.json(await fetchLinkMembers(link, platform));
  } catch (error) {
    return sendServiceError(res, 'lms_members_failure', error);
  }
});

InternalSyncRoute.post(
  '/internal/units/:unitId/course-data',
  async (req: Request, res: Response) => {
    const link = await linkForUnit(req, res);
    if (!link) return;

    const body = req.body as Record<string, unknown>;
    const assignmentId =
      typeof body.assignmentId === 'number' &&
      Number.isInteger(body.assignmentId) &&
      body.assignmentId > 0
        ? String(body.assignmentId)
        : typeof body.assignmentId === 'string' && /^[1-9]\d*$/.test(body.assignmentId)
          ? body.assignmentId
          : undefined;
    if (body.assignmentId !== undefined && body.assignmentId !== null && !assignmentId) {
      return res.status(400).json({ error: 'assignmentId must be a positive integer' });
    }

    try {
      const include = courseDataSectionsFrom(body.include);
      const platform = await platformForLink(link);
      const snapshot = await fetchStoredMoodleCourseData(link, platform, {
        ...(assignmentId ? { assignmentId } : {}),
        ...(include ? { include } : {}),
      });
      if (!link.courseDataAvailable) {
        link.courseDataAvailable = true;
        link.capabilitiesCheckedAt = new Date();
        await link.save();
      }
      return res.json(snapshot);
    } catch (error) {
      // 422 means Moodle rejected the plugin request, e.g. the plugin was uninstalled.
      if (error instanceof LtiServiceError && error.status === 422 && link.courseDataAvailable) {
        link.courseDataAvailable = false;
        link.capabilitiesCheckedAt = new Date();
        await link.save();
      }
      return sendServiceError(res, 'lms_course_data_failure', error);
    }
  },
);

InternalSyncRoute.get(
  '/internal/units/:unitId/grade-line-item',
  async (req: Request, res: Response) => {
    const link = await linkForUnit(req, res);
    if (!link) return;

    try {
      const platform = await platformForLink(link);
      return res.json(await storedGradeLineItemStatus(link, platform));
    } catch (error) {
      return sendGradeLineItemError(res, 'lms_grade_line_item_failure', error);
    }
  },
);

InternalSyncRoute.post(
  '/internal/units/:unitId/grade-line-item',
  async (req: Request, res: Response) => {
    const link = await linkForUnit(req, res);
    if (!link) return;

    try {
      const platform = await platformForLink(link);
      return res.json(await ensureStoredGradeLineItem(link, platform));
    } catch (error) {
      return sendGradeLineItemError(res, 'lms_grade_line_item_retry_failure', error);
    }
  },
);

/*
 * Submits scores for LMS users. Each score is reported separately so one failure does not stop
 * the remaining grades from syncing.
 */
InternalSyncRoute.post('/internal/units/:unitId/scores', async (req: Request, res: Response) => {
  const link = await linkForUnit(req, res);
  if (!link) return;

  const scores = (req.body as Record<string, unknown>).scores;
  if (
    !Array.isArray(scores) ||
    !scores.every(
      (score) =>
        score &&
        typeof score.userId === 'string' &&
        score.userId &&
        typeof score.scoreGiven === 'number' &&
        Number.isFinite(score.scoreGiven) &&
        (score.comment === undefined || typeof score.comment === 'string'),
    )
  ) {
    return res.status(400).json({
      error: 'scores must contain userId, numeric scoreGiven and an optional text comment',
    });
  }

  let platform;
  try {
    platform = await platformForLink(link);
  } catch (error) {
    return sendServiceError(res, 'lms_score_failure', error);
  }

  const results: { userId: string; success: boolean; error?: string }[] = [];
  for (const score of scores as { userId: string; scoreGiven: number; comment?: string }[]) {
    try {
      await submitLinkScore(link, platform, {
        userId: score.userId,
        scoreGiven: score.scoreGiven,
        scoreMaximum: 100,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
        timestamp: new Date().toISOString(),
        ...(score.comment ? { comment: score.comment } : {}),
      });
      results.push({ userId: score.userId, success: true });
    } catch (error) {
      results.push({
        userId: score.userId,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return res.json({ results });
});
