import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Result, Score } from 'ltijs';
import { Config } from '../config';
import { sendError } from '../errors';
import { ltiContextId, ltiResourceId } from '../lti-claims';
import UnitLink from '../schema/unitLink.model';

export const GradeRouter = express.Router();

/*
 * Sync grades for all members in the context
 */
GradeRouter.post('/grades', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return sendError(res, 'Invalid Lti Token', 400);
  }

  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    return sendError(res, 'LTI launch does not include a context ID', 400);
  }

  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return sendError(res, 'No unit is linked to this course', 404);
  }

  const members = await launchContext.namesAndRoles.getMembers();
  if (!members) {
    return sendError(res, 'Unable to retrieve members', 400);
  }

  const newToken = {
    unit_id: link.unitId,
    student_emails: [...members.members.map((m) => m.email)],
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
    jti: crypto.randomUUID(),
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`${Config.API_HOST}/api/lti/grades`, {
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

  const data = (await response.json()) as Record<string, number> | null;
  if (data === null) {
    return sendError(res, 'Failed to retrieve grades', 404);
  }

  let lineItemId = launchContext.idToken.services.assignmentAndGrades.lineItemId;

  if (!lineItemId) {
    const response = await launchContext.grading.getLineItems({ resourceLinkId: true });
    const lineItems = response.lineItems;
    if (lineItems.length === 0) {
      // Creating line item if there is none
      const newLineItem = {
        scoreMaximum: 100,
        label: 'Grade',
        tag: 'grade',
        resourceLinkId: ltiResourceId(launchContext),
      };
      const lineItem = await launchContext.grading.createLineItem(newLineItem, {
        resourceLinkId: true,
      });
      lineItemId = lineItem.id;
    } else lineItemId = lineItems[0]?.id;
  }

  if (!lineItemId) {
    return sendError(res, 'Unable to find or create a grade line item', 400);
  }

  const gradesSynced: {
    success: { row: string; message: string }[];
    errors: { row: string; message: string }[];
    ignored: { row: string; message: string }[];
  } = {
    success: [],
    errors: [],
    ignored: [],
  };
  for (const user of members.members) {
    const email = typeof user.email === 'string' ? user.email : undefined;
    const grade = email ? data[email] : undefined;

    if (grade === null || grade === undefined) {
      gradesSynced.ignored.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'Project not found',
      });
      continue;
    }

    if (grade === -1) {
      gradesSynced.errors.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'No permission to retrieve grade',
      });
      continue;
    }

    if (grade === 0) {
      gradesSynced.ignored.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'No grades found',
      });
      continue;
    }

    try {
      const gradeObj: Score = {
        // userId: token.user,
        userId: user.userId,
        scoreGiven: grade,
        scoreMaximum: 100,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
      };
      // Sending Grade
      const responseGrade = await launchContext.grading.submitScore(lineItemId, gradeObj);
      if (responseGrade) {
        gradesSynced.success.push({
          row: JSON.stringify(user).replaceAll('\\', ''),
          message: `Grade synced: ${grade}%`,
        });
      }
    } catch (e) {
      console.error(`Unable to submit scores for ${user.name}`, e);
      gradesSynced.success.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: `Failed to submit score`,
      });
    }
  }

  return res.send(gradesSynced);
});

/*
 * Retrieves the grade for a context member
 */
GradeRouter.get('/grade', async (req: Request, res: Response) => {
  const launchContext = res.locals.launchContext;
  if (!launchContext) {
    return res.status(403);
  }

  let lineItemId = launchContext.idToken.services.assignmentAndGrades.lineItemId;

  if (!lineItemId) {
    const { lineItems } = await launchContext.grading.getLineItems({ resourceLinkId: true });
    lineItemId = lineItems[0]?.id;
  }

  if (!lineItemId) {
    return res.status(404).send();
  }

  const response = await launchContext.grading.getScores(lineItemId, {
    userId: launchContext.idToken.user.id,
  });
  if (!response.scores.length) {
    return res.status(404);
  }

  const result = response.scores.find(
    (score: Result) => score.userId === launchContext.idToken.user.id,
  );

  res.json(result);
});
