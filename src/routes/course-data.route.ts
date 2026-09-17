import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Config } from '../config';
import { sendError } from '../errors';
import { ltiContextId } from '../lti-claims';
import MoodleCourseConnection from '../schema/moodleCourseConnection.model';
import UnitLink from '../schema/unitLink.model';
import {
  MoodleCourseDataServiceError,
  courseDataSectionsFrom,
  getMoodleCourseData,
  rememberMoodleCourseConnection,
  selectedAssignmentData,
} from '../services/moodle-course-data.service';

export const CourseDataRouter = express.Router();

function isTeacherLaunch(roles: readonly string[]): boolean {
  return roles.some((role) =>
    /(?:#|\/)(Instructor|TeachingAssistant|Administrator|ContentDeveloper|Manager)$/.test(role),
  );
}

async function authoriseUnitManagement(
  req: Request,
  unitId: string,
): Promise<{ ok: true } | { ok: false; status: number; body: unknown }> {
  const signedToken = jwt.sign(
    {
      unit_id: unitId,
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
      'Auth-Token': String(req.headers['auth-token'] ?? ''),
      Username: String(req.headers['username'] ?? ''),
    },
    body: JSON.stringify({ ltik: signedToken }),
  });
  if (response.ok) return { ok: true };
  return {
    ok: false,
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function teacherCourse(
  req: Request,
  res: Response,
): Promise<{ contextId: string; link: { unitId: string } } | undefined> {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    sendError(res, 'Invalid LTI token', 403);
    return;
  }
  if (!isTeacherLaunch(launchContext.idToken.user.roles)) {
    sendError(res, 'Only teaching staff can manage Moodle course data', 403);
    return;
  }
  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    sendError(res, 'LTI launch does not include a context ID', 400);
    return;
  }
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    sendError(res, 'Link this Moodle course to an OnTrack unit first', 404);
    return;
  }
  const authorisation = await authoriseUnitManagement(req, link.unitId);
  if (!authorisation.ok) {
    sendError(res, authorisation.body, authorisation.status);
    return;
  }
  return { contextId, link };
}

function assignmentIdFrom(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  return undefined;
}

CourseDataRouter.get('/course-data', async (req: Request, res: Response) => {
  const course = await teacherCourse(req, res);
  if (!course) return;
  const assignmentId =
    req.query.assignmentId === undefined ? undefined : assignmentIdFrom(req.query.assignmentId);
  if (req.query.assignmentId !== undefined && !assignmentId) {
    return sendError(res, 'assignmentId must be a positive integer', 400);
  }

  try {
    const include = courseDataSectionsFrom(req.query.include);
    const launchContext = res.locals.launchContext!;
    const connection = await rememberMoodleCourseConnection(launchContext);
    const snapshot = await getMoodleCourseData(launchContext, {
      ...(assignmentId ? { assignmentId } : {}),
      ...(include ? { include } : {}),
    });
    connection.lastFetchedAt = new Date();
    await connection.save();
    return res.json({
      unitId: course.link.unitId,
      selectedAssignmentId: connection.selectedAssignmentId ?? null,
      selectedAssignmentName: connection.selectedAssignmentName ?? null,
      ...selectedAssignmentData(snapshot, connection.selectedAssignmentId),
      snapshot,
    });
  } catch (error) {
    console.error('Unable to retrieve Moodle course data', error);
    return sendError(
      res,
      error instanceof Error ? error.message : 'Unable to retrieve Moodle course data',
      error instanceof MoodleCourseDataServiceError ? error.status : 502,
    );
  }
});

CourseDataRouter.put('/course-data/spec-con-assignment', async (req: Request, res: Response) => {
  const course = await teacherCourse(req, res);
  if (!course) return;
  const assignmentId = assignmentIdFrom(req.body?.assignmentId);
  if (!assignmentId) {
    return sendError(res, 'assignmentId must be a positive integer', 400);
  }

  try {
    const launchContext = res.locals.launchContext!;
    const connection = await rememberMoodleCourseConnection(launchContext);
    const snapshot = await getMoodleCourseData(launchContext, {
      assignmentId,
      include: ['assignments'],
    });
    const assignment = snapshot.assignments?.find((candidate) => candidate.id === assignmentId);
    if (!assignment) return sendError(res, 'Assignment was not found in this Moodle course', 404);

    connection.selectedAssignmentId = assignment.id;
    connection.selectedAssignmentName = assignment.name;
    connection.lastFetchedAt = new Date();
    await connection.save();
    return res.json({
      unitId: course.link.unitId,
      selectedAssignmentId: assignment.id,
      selectedAssignmentName: assignment.name,
      ...selectedAssignmentData(snapshot, assignment.id),
    });
  } catch (error) {
    console.error('Unable to save the Moodle special-consideration assignment', error);
    return sendError(
      res,
      error instanceof Error
        ? error.message
        : 'Unable to save the Moodle special-consideration assignment',
      error instanceof MoodleCourseDataServiceError ? error.status : 502,
    );
  }
});

CourseDataRouter.delete('/course-data/spec-con-assignment', async (req: Request, res: Response) => {
  const course = await teacherCourse(req, res);
  if (!course) return;
  await MoodleCourseConnection.updateOne(
    { contextId: course.contextId },
    { $unset: { selectedAssignmentId: 1, selectedAssignmentName: 1 } },
  );
  return res.status(204).send();
});
