import express from 'express';
import { Config } from './config';
import { InternalSyncRoute } from './routes/internal-sync.route';

// Internal API called by OnTrack's Rails API, on its own port so the public proxy never routes to it.
export function startInternalServer(): void {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/lti/api', InternalSyncRoute);

  app.listen(Config.INTERNAL_PORT, () => {
    console.log(`Running internal LTI API on port ${Config.INTERNAL_PORT}`);
  });
}
