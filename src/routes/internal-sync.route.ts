import express, { Request, Response } from 'express';
import { IdToken, Provider as lti } from 'ltijs';
import { Config } from '../config';
import { LtiLaunchPayload } from '../types';

export const INTERNAL_SYNC_ROUTE_PATH = '/lti/api/internal/test-members';
export const InternalSyncRoute = express.Router();

InternalSyncRoute.post('/internal/test-members', async (req: Request, res: Response) => {
  if (!Config.INTERNAL_SYNC_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (req.header('x-internal-key') !== Config.INTERNAL_SYNC_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { issuer, clientId, contextId, user } = req.body as Record<string, unknown>;
  if (
    typeof issuer !== 'string' ||
    typeof clientId !== 'string' ||
    typeof contextId !== 'string' ||
    typeof user !== 'string'
  ) {
    return res.status(400).json({
      error: 'issuer, clientId, contextId and user must be strings',
    });
  }

  try {
    const storedContexts = await lti.Database.Get(false, 'contexttoken', {
      contextId,
      user,
    });

    if (!Array.isArray(storedContexts) || !storedContexts[0]) {
      return res.status(404).json({
        error: 'Stored LTI context not found; perform a new LMS launch',
      });
    }

    const platformContext = storedContexts[0] as LtiLaunchPayload['platformContext'];
    if (!platformContext?.namesRoles?.context_memberships_url) {
      return res.status(422).json({
        error: 'Stored LTI context does not include an NRPS memberships URL',
      });
    }

    const serviceToken = {
      iss: issuer,
      clientId,
      platformContext,
    } as unknown as IdToken;

    // Ltijs supports `pages: false` to retrieve every page, although its bundled
    // TypeScript declaration currently only permits numbers.
    const members = await lti.NamesAndRoles.getMembers(serviceToken, {
      pages: false as unknown as number,
    });

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
