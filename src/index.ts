import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ContentItem, IdToken, Provider as lti } from 'ltijs';
import mongoose from 'mongoose';
import {
  DB_HOST,
  DB_NAME,
  DB_PASS,
  DB_USER,
  LTI_API_SECRET,
  LTI_KEY,
  PLATFORM_ACCESS_TOKEN_ENDPOINT,
  PLATFORM_AUTHCONFIG_KEY,
  PLATFORM_AUTHCONFIG_METHOD,
  PLATFORM_AUTHENTICATION_ENDPOINT,
  PLATFORM_CLIENT_ID,
  PLATFORM_NAME,
  PLATFORM_URL,
  PORT,
} from './config';
import { LtiLaunchPayload } from './types';

lti.setup(
  LTI_KEY,
  {
    url: `mongodb://${DB_HOST}/${DB_NAME}?authSource=admin`,
    connection: DB_USER && DB_PASS ? { user: DB_USER, pass: DB_PASS } : undefined,
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

  // TODO: If we got the original JWT of _token, we would be able to use Moodle's public key to verify the token
  // TODO: this way we wouldn't need this LTI_JWT_SECRET (LTI_KEY)

  const token = _token as unknown as LtiLaunchPayload;

  const context = token.platformContext?.context;
  if (context && context.id && context.label && context.title) {
    console.log(`Context is ${context.label} - ${context.title}`);
    console.log(context.type);
  }

  const roles = token.platformContext?.roles;
  console.log(roles);

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
  // TODO: set a short expiry on the jwt (a few seconds)
  // TODO: attach more information like user-agent and IP to this token
  // TODO: .. so that when user tries using it to log in to the api, it ensures IPs match

  // console.log(req.ip);
  // console.log(req.get('user-agent'));

  // https://community.canvaslms.com/t5/Developers-Group/LTI-1-3-mixing-roles/td-p/576665
  lti.NamesAndRoles.getMembers(_token).then((result) => {
    if (result) {
      for (const member of result.members) {
        /*
          TODO: handle specific permissions in the insutition config
          System Roles:
          - Highest level of access across the entire LMS
          - /system/person#User
          - /system/person#SysAdmin
          Institution Roles:
          - Administrator, Instruction, Student
          - /institution/person#Administrator
          - /institution/person#Instructor
          - /institution/person#Student
          Context (Course) Roles:
          - Instructor, Student
          - /membership#Instructor
          - /membership#Student || /membership#Learner
        */
        console.log(member.roles);
        if (member.roles.some((role) => role === 'Learner')) {
          console.log(`${member.name} is a Student in ${result.context.title}!`);
        } else if (member.roles.some((role) => role === 'Instructor')) {
          console.log(`${member.name} is an Instructor (Teacher) for ${result.context.title}!`);
        } else if (member.roles.some((role) => role === 'Administrator')) {
          console.log(`${member.name} is an Administrator for ${result.context.title}!`);
        }
      }
    }
  });

  const signedToken = jwt.sign(newToken, LTI_API_SECRET);

  // TODO: replace with env var
  res.redirect(`http://localhost:4200/sign_in?ltiToken=${signedToken}`);
});

// app.set('trust proxy', true);

const ltiRouter = express.Router();

lti.app.use(express.urlencoded({ extended: true }));

// TODO: OnTrack will post to this route with the unit to link to
ltiRouter.post('/deeplink', async (req: Request, res: Response) => {
  if (!res.locals.token) {
    return;
  }
  try {
    const resource = req.body;

    const items: ContentItem[] = [
      {
        type: 'ltiResourceLink',
        title: 'Ltijs Demo',
        custom: {
          unit_id: resource.unit_id,
          // other custom key/value pairs eg.
          // otherValue: resource.otherValue,
          // anotherValue: resource.anotherValue,
        },
      },
    ];

    const form = await lti.DeepLinking.createDeepLinkingForm(res.locals.token, items, {
      message: 'Successfully Registered',
    });
    if (form) return res.send(form);
    return res.sendStatus(500);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return res.status(500).send(message);
  }
});

ltiRouter.get('/deeplink-redirect', (req, res) => {
  // This route is used when Instructors click "Select Content"
  // It redirects to a route within OnTrack that displays a form that Administrators can choose which unit to link to this unit.

  // TODO: Do we trust administrators to self enrol them into *existing* units?
  // TODO: Do we only let administrators/instructors linking units that they are already enrolled in within OnTrack?

  // TODO: if Administrator is creating a *new* unit, self enrol them as a Convenor
  // TODO: if the unit already exists, should it require the "lmsStaffCanSelfAssign" to be enabled?
  // TODO: self enrol Instructors as tutors into the unit

  res.redirect(`http://localhost:4200/lti/deeplink?ltik=${res.locals.ltik}`);
});

// ltiRouter.get('/info', async (_req: Request, res: Response) => {
//   const token = res.locals.token;
//   const context = res.locals.context;

//   if (!token || !context) {
//     return res.status(400);
//   }

//   const info: { name?: string; email?: string; roles?: any[]; context?: string } = {};
//   if (token.userInfo) {
//     if (token.userInfo.name) info.name = token.userInfo.name;
//     if (token.userInfo.email) info.email = token.userInfo.email;
//   }

//   if (context.roles) info.roles = context.roles;
//   if (context.context) info.context = context.context;

//   return res.send(info);
// });

const setup = async () => {
  try {
    await mongoose.connect(
      `mongodb://${DB_HOST}/${DB_NAME}?authSource=admin`,
      DB_USER && DB_PASS ? { user: DB_USER, pass: DB_PASS } : undefined,
    );
    console.log('MondoDB connected');
  } catch (error) {
    console.error(`MongoDB Connection Failed: ${error}`);
  }

  await lti.deploy({ port: Number(PORT) });

  await lti.registerPlatform({
    url: PLATFORM_URL,
    name: PLATFORM_NAME,
    clientId: PLATFORM_CLIENT_ID,
    authenticationEndpoint: PLATFORM_AUTHENTICATION_ENDPOINT,
    accesstokenEndpoint: PLATFORM_ACCESS_TOKEN_ENDPOINT,
    authConfig: {
      method: PLATFORM_AUTHCONFIG_METHOD,
      key: PLATFORM_AUTHCONFIG_KEY,
    },
  });
};

lti.app.use('/lti/api', ltiRouter);

setup();
