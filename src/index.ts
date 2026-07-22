import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { IdToken, Provider as lti } from 'ltijs';
import mongoose from 'mongoose';
import { Config } from './config';
import { sendError } from './errors';
import { EnrolmentRouter } from './routes/enrolment.route';
import { GradeRouter } from './routes/grade.route';
import { INTERNAL_SYNC_ROUTE_PATH, InternalSyncRoute } from './routes/internal-sync.route';
import { MemberRoute } from './routes/member.route';
import { UnitLinkRouter } from './routes/unit-link.route';
import { LtiLaunchPayload } from './types';

interface AuthResponse {
  username: string;
  auth_token: string;
}

class RailsAuthenticationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly railsStatus: number | null,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'RailsAuthenticationError';
  }
}

function parseResponseBody(body: string): unknown {
  if (!body) return null;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function railsErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body) return body;
  if (!body || typeof body !== 'object') return fallback;

  for (const key of ['error', 'message']) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const nestedMessage = (value as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string' && nestedMessage) return nestedMessage;
    }
  }

  return fallback;
}

lti.setup(
  Config.LTI_KEY,
  {
    url: `mongodb://${Config.DB_HOST}/${Config.DB_NAME}?authSource=admin`,
    connection:
      Config.DB_USER && Config.DB_PASS ? { user: Config.DB_USER, pass: Config.DB_PASS } : undefined,
  },
  {
    appUrl: '/lti/api/',
    loginUrl: '/lti/api/login',
    keysetUrl: '/lti/api/keys',
    cookies: {
      // Set secure to true if the testing platform is in a different domain and https is being used
      secure: Config.LTI_COOKIES_SECURE,
      // Set sameSite to 'None' if the testing platform is in a different domain and https is being used
      sameSite: Config.LTI_COOKIES_SAMESITE,
    },
    // Set DevMode to true if the testing platform is in a different domain and https is not being used
    devMode: !Config.IS_PRODUCTION,
  },
);

// When receiving successful LTI launch redirects to app
lti.onConnect((_token: IdToken, req: Request, res: Response) => {
  const token = _token as unknown as LtiLaunchPayload;

  const context = token.platformContext?.context;
  if (context && context.id && context.label && context.title) {
    console.log(`Context is ${context.label} - ${context.title}`);
    console.log(context.type);
  }

  lti.NamesAndRoles.getMembers(_token!)
    .then((members) => {
      if (!members) {
        return sendError(res, 'Could not retrieve member information', 400);
      }
      const member = members.members.find((m) => m.user_id === token.user);
      if (!member) {
        return sendError(res, 'Could not retrieve member information', 400);
      }
      const newToken = {
        member: member,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
        jti: crypto.randomUUID(),
      };
      const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

      // Create user and generate one-time auth token for the user to sign in with
      const authUrl = `${Config.API_HOST}/api/auth/lti`;
      console.info(JSON.stringify({ event: 'rails_authentication_request', url: authUrl }));

      fetch(authUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ltik: signedToken,
        }),
      })
        .then(async (response) => {
          const responseBody = parseResponseBody(await response.text());
          if (!response.ok) {
            throw new RailsAuthenticationError(
              railsErrorMessage(
                responseBody,
                `Rails authentication failed with ${response.status} ${response.statusText}`,
              ),
              response.status,
              response.status,
              responseBody,
            );
          }

          const auth = responseBody as Partial<AuthResponse> | null;
          if (!auth || typeof auth !== 'object' || !auth.auth_token || !auth.username) {
            throw new RailsAuthenticationError(
              'Rails authentication response did not include user credentials',
              502,
              response.status,
              responseBody,
            );
          }

          console.info(
            JSON.stringify({
              event: 'rails_authentication_response',
              url: authUrl,
              status: response.status,
            }),
          );
          // Do not log the successful response body because it contains an authentication token.
          return auth as AuthResponse;
        })
        .then((auth) => {
          res.redirect(
            `${Config.APP_HOST}/sign_in?ltik=${res.locals.ltik}&authToken=${auth.auth_token}&username=${auth.username}&isLtiLogin=true`,
          );
        })
        .catch((error) => {
          const authenticationError =
            error instanceof RailsAuthenticationError
              ? error
              : new RailsAuthenticationError(
                  error instanceof Error ? error.message : String(error),
                  502,
                  null,
                  null,
                );

          console.error(
            JSON.stringify({
              event: 'rails_authentication_failure',
              url: authUrl,
              status: authenticationError.status,
              railsStatus: authenticationError.railsStatus,
              responseBody: authenticationError.responseBody,
              error: authenticationError.message,
            }),
          );

          return sendError(res, authenticationError.message, authenticationError.status);
        });
    })
    .catch((error) => {
      return sendError(
        res,
        'Failed to get member information. Ensure our public Keyset URL is accessible from your platform.',
        error.status,
      );
    });
});

// app.set('trust proxy', true);

const ltiRouter = express.Router();

lti.app.use(express.urlencoded({ extended: true }));
ltiRouter.use(express.urlencoded({ extended: true }));
ltiRouter.use(express.json());
lti.app.use(express.json());

// This backend-only diagnostic route is disabled unless INTERNAL_SYNC_KEY is configured.
lti.whitelist({ route: INTERNAL_SYNC_ROUTE_PATH, method: 'POST' });

const setup = async () => {
  console.log(
    `Running LTI Server on port ${Config.PORT} in ${Config.IS_PRODUCTION ? 'Production' : 'Development'} mode`,
  );
  console.log(`LTI API host is ${Config.API_HOST}`);
  console.log(`LTI public application host is ${Config.APP_HOST}`);
  console.log(`Connecting to ${Config.DB_HOST}, ${Config.DB_NAME}.`);
  try {
    await mongoose.connect(
      `mongodb://${Config.DB_HOST}/${Config.DB_NAME}?authSource=admin`,
      Config.DB_USER && Config.DB_PASS ? { user: Config.DB_USER, pass: Config.DB_PASS } : undefined,
    );
    console.log('MondoDB connected');
  } catch (error) {
    console.error(`MongoDB Connection Failed: ${error}`);
  }

  await lti.deploy({ port: Number(Config.PORT) });

  await lti.registerPlatform({
    url: Config.PLATFORM_URL,
    name: Config.PLATFORM_NAME,
    clientId: Config.PLATFORM_CLIENT_ID,
    authenticationEndpoint: Config.PLATFORM_AUTHENTICATION_ENDPOINT,
    accesstokenEndpoint: Config.PLATFORM_ACCESS_TOKEN_ENDPOINT,
    authConfig: {
      method: Config.PLATFORM_AUTHCONFIG_METHOD,
      key: Config.PLATFORM_AUTHCONFIG_KEY,
    },
  });
};

lti.app.use('/lti/api', GradeRouter);
lti.app.use('/lti/api', EnrolmentRouter);
lti.app.use('/lti/api', UnitLinkRouter);
lti.app.use('/lti/api', MemberRoute);
lti.app.use('/lti/api', InternalSyncRoute);

setup();
