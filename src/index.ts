import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { IdToken, Provider as lti } from 'ltijs';
import mongoose from 'mongoose';
import { Config } from './config';
import { sendError } from './errors';
import { EnrolmentRouter } from './routes/enrolment.route';
import { GradeRouter } from './routes/grade.route';
import { MemberRoute } from './routes/member.route';
import { UnitLinkRouter } from './routes/unit-link.route';
import { LtiLaunchPayload } from './types';

interface AuthResponse {
  username: string;
  auth_token: string;
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
    // @ts-expect-error Type is not defined.
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
      fetch(`${Config.HOST}/api/auth/lti`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ltik: signedToken,
        }),
      })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) {
            throw data;
          }
          return data;
        })
        .then((data) => {
          const auth = data as AuthResponse;
          if (!auth.auth_token || !auth.username) {
            throw 'Failed to generate user credentials';
          }
          res.redirect(
            `${Config.HOST}/sign_in?ltik=${res.locals.ltik}&authToken=${auth.auth_token}&username=${auth.username}&isLtiLogin=true`,
          );
        })
        .catch((error) => {
          return sendError(res, error?.error ?? error, 403);
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

const setup = async () => {
  console.log(
    `Running LTI Server on port ${Config.PORT} in ${Config.IS_PRODUCTION ? 'Production' : 'Development'} mode`,
  );
  console.log(`LTI Host is running on ${Config.HOST}`);
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

setup();
