import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { ContentItem, IdToken, Provider as lti } from 'ltijs';
import mongoose from 'mongoose';
import {
  DB_HOST,
  DB_NAME,
  DB_PASS,
  DB_USER,
  LTI_KEY,
  LTI_SHARED_API_SECRET,
  PLATFORM_ACCESS_TOKEN_ENDPOINT,
  PLATFORM_AUTHCONFIG_KEY,
  PLATFORM_AUTHCONFIG_METHOD,
  PLATFORM_AUTHENTICATION_ENDPOINT,
  PLATFORM_CLIENT_ID,
  PLATFORM_NAME,
  PLATFORM_URL,
  PORT,
} from './config';
import UnitLink from './schema/unitLink.model';
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
    exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
    jti: crypto.randomUUID(),
  };

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

  console.log(LTI_SHARED_API_SECRET);

  const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

  // TODO: we could actually hit our Ruby api first to request the one time AuthToken
  // TODO: then our redirect could be localhost/sign_in?authToken=xxxxx&username=yyyyy
  // Currently we redirect -> sign_in?ltiToken -> /api/auth/lti -> sign_in?authToken -> /api/auth/jwt -> authenticated

  const originalToken = res.locals.ltik;
  // TODO: very important that we don't lose the originalToken, we need this when making requests back to /info
  // TODO: but now our signed token can be much more minimal
  console.log(originalToken);

  // TODO: replace with env var
  res.redirect(`http://localhost:4200/sign_in?ltik=${originalToken}&ltiToken=${signedToken}`);
});

// app.set('trust proxy', true);

const ltiRouter = express.Router();

lti.app.use(express.urlencoded({ extended: true }));
ltiRouter.use(express.urlencoded({ extended: true }));
ltiRouter.use(express.json());
lti.app.use(express.json());

ltiRouter.get('/members', async (req: Request, res: Response) => {
  const token = res.locals.token;
  if (!token) {
    return res.status(403).send({ error: 'Invalid Lti token' });
  }
  const members = await lti.NamesAndRoles.getMembers(token);
  return res.json(members);

  // if (result) {
  //   for (const member of result.members) {
  //     /*
  //       TODO: handle specific permissions in the insutition config
  //       System Roles:
  //       - Highest level of access across the entire LMS
  //       - /system/person#User
  //       - /system/person#SysAdmin
  //       Institution Roles:
  //       - Administrator, Instruction, Student
  //       - /institution/person#Administrator
  //       - /institution/person#Instructor
  //       - /institution/person#Student
  //       Context (Course) Roles:
  //       - Instructor, Student
  //       - /membership#Instructor
  //       - /membership#Student || /membership#Learner
  //     */
  //     console.log(member.roles);
  //     if (member.roles.some((role) => role === 'Learner')) {
  //       console.log(`${member.name} is a Student in ${result.context.title}!`);
  //     } else if (member.roles.some((role) => role === 'Instructor')) {
  //       console.log(`${member.name} is an Instructor (Teacher) for ${result.context.title}!`);
  //     } else if (member.roles.some((role) => role === 'Administrator')) {
  //       console.log(`${member.name} is an Administrator for ${result.context.title}!`);
  //     }
  //   }
  // }
});

ltiRouter.get('/deeplink-redirect', (req, res) => {
  // Redirects instructors to OnTrack's UI to select a unit to link to the LMS context.
  res.redirect(`http://localhost:4200/lti/deeplink?ltik=${res.locals.ltik}`);
});

/*
 * Retrieves linked unit information for a context
 */
ltiRouter.get('/link', async (req: Request, res: Response) => {
  console.log('getting a link for a context!!');
  console.log(res.locals.token);
  const _token = res.locals.token;

  // const contextId = req.query.contextId;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;
  const link = await UnitLink.findOne({ contextId });
  res.json(link);
  // res.json(JSON.stringify('yooo'));
});

/*
 * Links a unit to an LMS context
 */
ltiRouter.post('/link', async (req: Request, res: Response) => {
  console.log(res.locals.token);
  // console.log(req, res);
  const { unitId } = req.body;
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  // TODO: validate request with our ruby API first

  // const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

  // // TODO: signedToken as a query param or an Authorization header?
  // const response = await fetch(`http://localhost:4200/api/lti/deeplink?ltik=${signedToken}`, {
  //   method: 'GET',
  //   headers: {
  //     // Authorization: String(req.headers['authorization'] ?? ''), //
  //     'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
  //     Username: String(req.headers['username'] ?? ''),
  //   },
  // });

  // TODO: i think we should only link contextId <-> unitId
  // TODO: and then we fetch the unit details on every launch
  // TODO: (ensures our unit code, name is accurate every time)
  const result = await UnitLink.findOneAndUpdate(
    { contextId },
    { unitId },
    { upsert: true, new: true },
  );
  res.json(result);
});

/*
 * Enrols an LMS user into the linked OnTrack Unit
 */
ltiRouter.post('/enrol', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  console.log('context id to search is ', contextId);
  // Has our context been linked to an OnTrack unit?
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).json({ error: 'Unit link not found' });
  }

  console.log('link found', link);

  // TODO: check the roles of this incoming token

  const newToken = {
    unit_id: link?.unitId,
  };

  console.log('sigining', newToken);

  const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

  // TODO: signedToken as a query param or an Authorization header?
  const response = await fetch(`http://localhost:4200/api/lti/enrol?ltik=${signedToken}`, {
    method: 'POST',
    headers: {
      // Authorization: String(req.headers['authorization'] ?? ''), //
      'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
      Username: String(req.headers['username'] ?? ''),
    },
  });

  console.log(response);
  if (response.status !== 200) {
    return res.status(response.status).json({ error: response });
  }
  const data = await response.json();

  console.log(data);
  res.json(data);
});

/*
 * Removes link between a unit and the LMS context
 */
ltiRouter.delete('/link', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  await UnitLink.deleteMany({ contextId });
  res.status(204).send();
});

ltiRouter.get('/', (req, res) => {
  console.log('INDEX');
  console.log(req);
});

// // Handles form submission from OnTrack's UI to link a unit to the LMS context.
// // Stores the deeplink mapping in MongoDB.
// ltiRouter.post('/deeplink', async (req: Request, res: Response) => {
//   const _token = res.locals.token;
//   const token = _token as unknown as LtiLaunchPayload;
//   const resource = req.body;

//   if (!token || !_token) {
//     return res.sendStatus(403);
//   }

//   if (!resource.unit_id) {
//     return res.sendStatus(400);
//   }

//   // TODO: helper function to resign LtiToken payload
//   // Re-sign new JWT with smaller payload
//   const newToken: LtiLaunchPayload = {
//     iss: token.iss,
//     user: token.user,
//     platformContext: {
//       roles: token.platformContext?.roles,
//       context: token.platformContext?.context,
//       endpoint: token.platformContext?.endpoint,
//     },
//     userInfo: token.userInfo,
//     platformInfo: token.platformInfo,
//     // Append our deeplink request data
//     deeplinkRequest: {
//       unit_id: resource.unit_id,
//     },
//     iat: Math.floor(Date.now() / 1000),
//     exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
//     jti: crypto.randomUUID(),
//   };

//   try {
//     const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

//     // TODO: signedToken as a query param or an Authorization header?
//     const response = await fetch(`http://localhost:4200/api/lti/deeplink?ltik=${signedToken}`, {
//       method: 'GET',
//       headers: {
//         // Authorization: String(req.headers['authorization'] ?? ''), //
//         'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
//         Username: String(req.headers['username'] ?? ''),
//       },
//     });

//     const message = await response.json();

//     if (response.status !== 200) {
//       console.log(response);
//       console.log(message);

//       if (JSON.stringify(message) !== '{}') {
//         // Forward any error messages from Ruby API
//         return res.status(response.status).send(message);
//       } else {
//         return res.sendStatus(response.status);
//       }
//     }

//     console.log(response);
//     console.log(response.status);

//     const items: ContentItem[] = [
//       {
//         type: 'ltiResourceLink',
//         title: 'Ltijs Demo',
//         custom: {
//           unit_id: resource.unit_id,
//           // other custom key/value pairs eg.
//           // othqerValue: resource.otherValue,
//           // anotherValue: resource.anotherValue,
//         },
//       },
//     ];

//     // TODO: does this overwrite previously linked content?
//     const form = await lti.DeepLinking.createDeepLinkingForm(res.locals.token!, items, {
//       message: 'Successfully Registered',
//     });

//     // Stringify the form becaus OnTrack will always attempt to parse responses as JSON (unless specified)
//     if (form) return res.send(JSON.stringify(form));
//     return res.sendStatus(500);
//   } catch (err: unknown) {
//     const message = err instanceof Error ? err.message : 'Unknown error';
//     return res.status(500).send(message);
//   }
// });

ltiRouter.get('/info', async (_req: Request, res: Response) => {
  const _token = res.locals.token;
  const token = _token as unknown as LtiLaunchPayload;

  console.log(token);
  console.log(res.locals.context);
  // const context = res.locals.context;
  const context = token.platformContext;

  if (!token || !context) {
    return res.status(400);
  }

  const info: {
    name?: string;
    email?: string;
    roles?: string[];
    custom?: any;
    context?:
      | {
          id?: string;
          label?: string;
          title?: string;
          type?: string[];
        }
      | undefined;
  } = {};
  if (token.userInfo) {
    if (token.userInfo.name) info.name = token.userInfo.name;
    if (token.userInfo.email) info.email = token.userInfo.email;
  }

  if (context.roles) info.roles = context.roles;
  if (context.context) info.context = context.context;
  if (context.custom) info.custom = context.custom;

  return res.send(info);
});

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
