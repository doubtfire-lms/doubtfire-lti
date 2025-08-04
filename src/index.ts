import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { IdToken, Provider as lti } from 'ltijs';
import mongoose from 'mongoose';
import { LtiLaunchPayload } from './types';

dotenv.config();

if (!process.env.LTI_KEY) {
  throw 'LTI_KEY is not defined';
}

const LTI_KEY = process.env.LTI_KEY;
// if (!process.env.DB_USER) {
//   throw 'DB_USER is not defined';
// }

// if (!process.env.DB_PASS) {
//   throw 'DB_PASS is not defined';
// }

// const DB_USER = process.env.DB_USER!;
// const DB_PASS = process.env.DB_PASS!;
const DB_HOST = process.env.DB_HOST!;
const DB_NAME = process.env.DB_NAME!;

lti.setup(
  LTI_KEY,
  {
    url: `mongodb://${DB_HOST}/${DB_NAME}?authSource=admin`,
    // connection: { user: DB_USER, pass: DB_PASS },
  },
  {
    appUrl: '/lti/',
    loginUrl: '/lti/login',
    keysetUrl: '/lti/keys',
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
  const token = _token as unknown as LtiLaunchPayload;

  // Re-sign new JWT with smaller payload
  const newToken: LtiLaunchPayload = {
    iss: token.iss,
    user: token.user,
    platformContext: {
      roles: token.platformContext?.roles,
      context: token.platformContext?.context,
      endpoint: token.platformContext?.endpoint,
    },
    userInfo: token.userInfo,
    platformInfo: token.platformInfo,
    iat: Math.floor(Date.now() / 1000),
  };

  const signedToken = jwt.sign(newToken, LTI_KEY);
  res.redirect(`http://localhost:4200/sign_in?ltiToken=${signedToken}`);
});

const PORT = process.env.PORT || 3001;
// app.set('trust proxy', true);

const ltiRouter = express.Router();

lti.app.use(express.urlencoded({ extended: true }));

lti.app.use('/lti', ltiRouter);

ltiRouter.get('/info', async (_req: Request, res: any) => {
  const token = res.locals.token;
  const context = res.locals.context;

  if (!token || !context) {
    return res.status(400);
  }

  const info: { name?: string; email?: string; roles?: any[]; context?: string } = {};
  if (token.userInfo) {
    if (token.userInfo.name) info.name = token.userInfo.name;
    if (token.userInfo.email) info.email = token.userInfo.email;
  }

  if (context.roles) info.roles = context.roles;
  if (context.context) info.context = context.context;

  return res.send(info);
});

const setup = async () => {
  await mongoose
    .connect(
      `mongodb://${DB_HOST}/${DB_NAME}?authSource=admin`,
      // {
      // user: process.env.DB_USER!,
      // pass: process.env.DB_PASS!,
      // },
    )
    .then(() => {
      console.log('MongoDB connected');
    })
    .catch((err) => {
      console.error('MongoDB connection error:', err);
    });

  await lti.deploy({ port: Number(PORT) });

  await lti.registerPlatform({
    url: process.env.PLATFORM_URL!,
    name: process.env.PLATFORM_NAME!,
    clientId: process.env.PLATFORM_CLIENT_ID!,
    authenticationEndpoint: process.env.PLATFORM_AUTHENTICATION_ENDPOINT!,
    accesstokenEndpoint: process.env.PLATFORM_ACCESS_TOKEN_ENDPOINT!,
    authConfig: {
      method: process.env.PLATFORM_AUTHCONFIG_METHOD!,
      key: process.env.PLATFORM_AUTHCONFIG_KEY!,
    },
  });
};

setup();
