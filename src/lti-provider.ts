import { DefaultLogger, ExpressHttpHandler, MongoLegacyDatabaseManager, Provider } from 'ltijs';
import { Config } from './config';
import { installLtiSessionMiddleware } from './lti-session';
import { installLtiRateLimits } from './rate-limit';

const logger = new DefaultLogger();
const databaseUrl = `mongodb://${Config.DB_HOST}/${Config.DB_NAME}?authSource=admin`;
const databaseConfig =
  Config.DB_USER && Config.DB_PASS
    ? { url: databaseUrl, connection: { user: Config.DB_USER, pass: Config.DB_PASS } }
    : { url: databaseUrl };

export const ltiHttpHandler = new ExpressHttpHandler(logger, {
  port: Number(Config.PORT),
  cors: false,
});

installLtiRateLimits(ltiHttpHandler.app);

installLtiSessionMiddleware(ltiHttpHandler.app, async (ltik) => lti.getLaunchContext(ltik));

export const lti = new Provider({
  databaseManager: new MongoLegacyDatabaseManager(logger, databaseConfig, Config.LTI_KEY),
  httpHandler: ltiHttpHandler,
  logger,
  routes: {
    launchRoute: '/lti/api/',
    loginRoute: '/lti/api/login',
    keysetRoute: '/lti/api/keys',
  },
});
