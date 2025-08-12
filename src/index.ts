import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { IdToken, Provider as lti } from 'ltijs';
import mongoose from 'mongoose';
import { Config } from './config';
import { EnrolmentRouter } from './routes/enrolment.route';
import { GradeRouter } from './routes/grade.route';
import { MemberRoute } from './routes/member.route';
import { UnitLinkRouter } from './routes/unit-link.route';
import { LtiLaunchPayload } from './types';

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
      secure: false,
      // Set sameSite to 'None' if the testing platform is in a different domain and https is being used
      sameSite: '',
    },
    // @ts-expect-error Type is not defined.
    // Set DevMode to true if the testing platform is in a different domain and https is not being used
    devMode: true,
  },
);

// When receiving successful LTI launch redirects to app
lti.onConnect((_token: IdToken, req: Request, res: Response) => {
  if (!_token) {
    console.error('Invalid token?');
    // TODO: if JWT expires.. redirect to /unauthenticated? Inform user to refresh the page?
    // TODO: use lti.invalidTokenUrl
  }

  const token = _token as unknown as LtiLaunchPayload;

  const context = token.platformContext?.context;
  if (context && context.id && context.label && context.title) {
    console.log(`Context is ${context.label} - ${context.title}`);
    console.log(context.type);
  }

  lti.NamesAndRoles.getMembers(_token!).then((members) => {
    if (!members) {
      return res.status(404).json({ error: 'Could not retrieve member information' });
    }
    const member = members.members.find((m) => m.user_id === token.user);

    // TODO: attach more information like user-agent and IP to this token
    // TODO: .. so that when user tries using it to log in to the api, it ensures IPs match
    // console.log(req.ip);
    // console.log(req.get('user-agent'));

    const newToken = {
      member: member,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
      jti: crypto.randomUUID(),
    };
    const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

    // Ensure we pass on our ltik (token)
    const originalToken = res.locals.ltik;

    // TODO: we could actually hit our Ruby api first to request the one time AuthToken
    // TODO: then our redirect could be localhost/sign_in?authToken=xxxxx&username=yyyyy
    // Currently we redirect -> sign_in?ltiToken -> /api/auth/lti -> sign_in?authToken -> /api/auth/jwt -> authenticated

    res.redirect(`${Config.HOST}/sign_in?ltik=${originalToken}&ltiToken=${signedToken}`);
  });
});

// app.set('trust proxy', true);

const ltiRouter = express.Router();

lti.app.use(express.urlencoded({ extended: true }));
ltiRouter.use(express.urlencoded({ extended: true }));
ltiRouter.use(express.json());
lti.app.use(express.json());

const setup = async () => {
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
