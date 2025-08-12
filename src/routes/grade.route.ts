import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { RetrievedGrade, Provider as lti } from 'ltijs';
import { Config } from '../config';
import UnitLink from '../schema/unitLink.model';
import { LtiLaunchPayload } from '../types';

export const GradeRouter = express.Router();

/*
 * Sync grades for all members in the context
 */
GradeRouter.post('/grades', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  if (!_token) {
    return res.status(400).send({ error: 'Invalid Lti token' });
  }

  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).send({ error: 'No unit is linked to this course' });
  }

  const members = await lti.NamesAndRoles.getMembers(_token);
  if (!members) {
    return res.status(400);
  }

  const newToken = {
    unit_id: link.unitId,
    student_emails: [...members.members.map((m) => m.email)],
  };

  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  const response = await fetch(`http://localhost:4200/api/lti/grades`, {
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

  const data = (await response.json()) as Record<string, number> | null;
  if (data === null) {
    return res.status(404);
  }

  let lineItemId = token.platformContext?.endpoint?.lineitem; // Attempting to retrieve it from idtoken

  if (!lineItemId) {
    // @ts-expect-error Outdated ltis @types.
    const response = await lti.Grade.getLineItems(_token, { resourceLinkId: true });
    const lineItems = response.lineItems;
    if (lineItems.length === 0) {
      // Creating line item if there is none
      const newLineItem = {
        scoreMaximum: 100,
        label: 'Grade',
        tag: 'grade',
        resourceLinkId: token.platformContext?.resource?.id,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
      };
      // @ts-expect-error Outdated ltis @types.
      const lineItem = await lti.Grade.createLineItem(_token, newLineItem);
      lineItemId = lineItem.id;
    } else lineItemId = lineItems[0].id;
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
    if (data[user.email] === null || data[user.email] === undefined) {
      gradesSynced.ignored.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'Project not found',
      });
      continue;
    }

    if (data[user.email] === -1) {
      gradesSynced.errors.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'No permission to retrieve grade',
      });
      continue;
    }

    if (data[user.email] === 0) {
      gradesSynced.ignored.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'No grades found',
      });
      continue;
    }

    try {
      const gradeObj = {
        // userId: token.user,
        userId: user.user_id,
        scoreGiven: data[user.email],
        scoreMaximum: 100,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
      };
      // Sending Grade
      // @ts-expect-error Outdated ltis @types.
      const responseGrade = await lti.Grade.submitScore(_token, lineItemId, gradeObj);
      if (responseGrade) {
        gradesSynced.success.push({
          row: JSON.stringify(user).replaceAll('\\', ''),
          message: `Grade synced: ${data[user.email]}%`,
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
  const _token = res.locals.token;
  if (!_token) {
    return res.status(403);
  }

  const token = _token as unknown as LtiLaunchPayload;

  const response = await lti.Grade.result(_token);
  if (!response) {
    return res.status(404);
  }

  // @ts-expect-error Outdated ltis @types.
  const result = response[0]?.results
    //
    .find((r: RetrievedGrade) => r.userId === token.user);

  res.json(result);
});
