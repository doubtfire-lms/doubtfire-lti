import express, { Request, Response } from 'express';
import { IdToken, Provider as lti } from 'ltijs';
import { Config } from '../config';
import UnitLink from '../schema/unitLink.model';

export const INTERNAL_SYNC_ROUTE_PATH = '/lti/api/internal/test-members';
export const InternalSyncRoute = express.Router();

InternalSyncRoute.post('/internal/test-members', async (req: Request, res: Response) => {
  if (!Config.INTERNAL_SYNC_KEY) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (req.header('x-internal-key') !== Config.INTERNAL_SYNC_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { unitId, contextId } = req.body as Record<string, unknown>;
  const hasContextId = typeof contextId === 'string' && contextId.length > 0;
  const hasUnitId = (typeof unitId === 'string' && unitId.length > 0) || typeof unitId === 'number';
  if (!hasUnitId && !hasContextId) {
    return res.status(400).json({
      error: 'unitId or contextId must be provided',
    });
  }

  try {
    const link = await UnitLink.findOne(hasContextId ? { contextId } : { unitId: String(unitId) });
    if (!link) {
      return res.status(404).json({
        error: 'Linked LMS context not found',
      });
    }

    if (!link.issuer || !link.clientId || !link.deploymentId || !link.membershipsUrl) {
      return res.status(422).json({
        error: 'Link does not include NRPS service details; launch and link the unit again',
      });
    }

    const serviceToken = {
      iss: link.issuer,
      clientId: link.clientId,
      deploymentId: link.deploymentId,
      platformContext: {
        context: { id: link.contextId },
        namesRoles: {
          context_memberships_url: link.membershipsUrl,
          service_versions: ['2.0'],
        },
      },
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
