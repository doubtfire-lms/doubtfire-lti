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
    if (!Config.LTI_INTERNAL_SYNC_KEY) {
      console.warn(
        'LTI_INTERNAL_SYNC_KEY is not set, so the internal API refuses every request and the OnTrack LMS tab and scheduled LMS sync will not work. Set it to the same value as in the Rails API.',
      );
    }
  });
}
