import express, { Request, Response } from 'express';
import { Config } from '../config';
import { lti } from '../lti-provider';

export const INTERNAL_SYNC_ROUTE_PATH = '/lti/api/internal/test-members';
export const InternalSyncRoute = express.Router();

InternalSyncRoute.post('/internal/test-members', async (req: Request, res: Response) => {
  if (!Config.INTERNAL_SYNC_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (req.header('x-internal-key') !== Config.INTERNAL_SYNC_KEY) {
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
