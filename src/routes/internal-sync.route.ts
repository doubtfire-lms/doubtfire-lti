import express, { Request, Response } from 'express';
import { Config } from '../config';
import { lti } from '../lti-provider';
import MoodleCourseConnection from '../schema/moodleCourseConnection.model';
import UnitLink from '../schema/unitLink.model';
import {
  MoodleCourseDataServiceError,
  courseDataSectionsFrom,
  fetchStoredMoodleCourseData,
  selectedAssignmentData,
} from '../services/moodle-course-data.service';

export const INTERNAL_SYNC_ROUTE_PATH = '/lti/api/internal/test-members';
export const InternalSyncRoute = express.Router();

function internalRequestAuthorised(req: Request): boolean {
  return !!Config.INTERNAL_SYNC_KEY && req.header('x-internal-key') === Config.INTERNAL_SYNC_KEY;
}

InternalSyncRoute.post('/internal/test-members', async (req: Request, res: Response) => {
  if (!Config.INTERNAL_SYNC_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (!internalRequestAuthorised(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

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
    console.error(
      JSON.stringify({
        event: 'nrps_test_failure',
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    return res.status(502).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

InternalSyncRoute.post('/internal/course-data', async (req: Request, res: Response) => {
  if (!Config.INTERNAL_SYNC_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (!internalRequestAuthorised(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body as Record<string, unknown>;
  const unitId = typeof body.unitId === 'string' && body.unitId ? body.unitId : undefined;
  const contextId =
    typeof body.contextId === 'string' && body.contextId ? body.contextId : undefined;
  const assignmentId =
    typeof body.assignmentId === 'number' && Number.isInteger(body.assignmentId)
      ? String(body.assignmentId)
      : typeof body.assignmentId === 'string' && /^[1-9]\d*$/.test(body.assignmentId)
        ? body.assignmentId
        : undefined;
  if (!unitId && !contextId) {
    return res.status(400).json({ error: 'unitId or contextId is required' });
  }
  if (body.assignmentId !== undefined && !assignmentId) {
    return res.status(400).json({ error: 'assignmentId must be a positive integer' });
  }

  let include;
  try {
    include = courseDataSectionsFrom(body.include);
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid include value',
    });
  }
  if (assignmentId && include && !include.includes('assignments')) {
    return res.status(400).json({ error: 'assignmentId requires assignments to be included' });
  }

  try {
    const link = contextId
      ? await UnitLink.findOne({ contextId })
      : await UnitLink.findOne({ unitId });
    if (!link) return res.status(404).json({ error: 'Linked Moodle course was not found' });
    if (unitId && link.unitId !== unitId) {
      return res.status(404).json({ error: 'Linked Moodle course was not found' });
    }
    const connection = await MoodleCourseConnection.findOne({ contextId: link.contextId });
    if (!connection) {
      return res.status(409).json({
        error: 'Moodle course-data connection is not stored; perform a fresh LTI launch first',
      });
    }
    const platform = await lti.platformManager.getPlatformById(connection.platformId);
    if (!platform)
      return res.status(409).json({ error: 'Registered Moodle platform was not found' });

    const snapshot = await fetchStoredMoodleCourseData(connection, platform, {
      ...(assignmentId ? { assignmentId } : {}),
      ...(include ? { include } : {}),
    });
    connection.lastFetchedAt = new Date();
    await connection.save();
    return res.json({
      unitId: link.unitId,
      contextId: link.contextId,
      selectedAssignmentId: connection.selectedAssignmentId ?? null,
      selectedAssignmentName: connection.selectedAssignmentName ?? null,
      ...selectedAssignmentData(snapshot, connection.selectedAssignmentId),
      snapshot,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'moodle_course_data_internal_fetch_failure',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return res.status(error instanceof MoodleCourseDataServiceError ? error.status : 502).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
