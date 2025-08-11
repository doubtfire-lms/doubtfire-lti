import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { IdToken, RetrievedGrade, Provider as lti } from 'ltijs';
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

// Endpoint to retrieve grade for a student within current context (course)
ltiRouter.get('/grade', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  if (!_token) {
    return res.status(403);
  }

  const token = _token as unknown as LtiLaunchPayload;

  const response = await lti.Grade.result(_token);
  if (!response) {
    return res.status(404);
  }

  // @ts-expect-error Outdated ltis @types.
  const result = response[0]?.results
    //
    .find((r: RetrievedGrade) => r.userId === token.user);

  res.json(result);
});

// Endpoint to submit grades for multiple students
ltiRouter.post('/grades', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  if (!_token) {
    return res.status(400).send({ error: 'Invalid Lti token' });
  }

  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).send({ error: 'No unit is linked to this course' });
  }

  const members = await lti.NamesAndRoles.getMembers(_token);
  if (!members) {
    return res.status(400);
  }

  const newToken = {
    unit_id: link.unitId,
    student_emails: [...members.members.map((m) => m.email)],
  };

  const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

  // TODO: signedToken as a query param or an Authorization header?
  const response = await fetch(`http://localhost:4200/api/lti/grades?ltik=${signedToken}`, {
    method: 'GET',
    headers: {
      // Authorization: String(req.headers['authorization'] ?? ''), //
      'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
      Username: String(req.headers['username'] ?? ''),
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return res.status(response.status).json(errorBody);
  }

  const data = (await response.json()) as Record<string, number> | null;
  if (data === null) {
    return res.status(404);
  }

  let lineItemId = token.platformContext?.endpoint?.lineitem; // Attempting to retrieve it from idtoken

  if (!lineItemId) {
    // @ts-expect-error Outdated ltis @types.
    const response = await lti.Grade.getLineItems(_token, { resourceLinkId: true });
    const lineItems = response.lineItems;
    if (lineItems.length === 0) {
      // Creating line item if there is none
      const newLineItem = {
        scoreMaximum: 100,
        label: 'Grade',
        tag: 'grade',
        resourceLinkId: token.platformContext?.resource?.id,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
      };
      // @ts-expect-error Outdated ltis @types.
      const lineItem = await lti.Grade.createLineItem(_token, newLineItem);
      lineItemId = lineItem.id;
    } else lineItemId = lineItems[0].id;
  }

  const gradesSynced: {
    success: { row: string; message: string }[];
    errors: { row: string; message: string }[];
    ignored: { row: string; message: string }[];
  } = {
    success: [],
    errors: [],
    ignored: [],
  };
  for (const user of members.members) {
    if (data[user.email] === null || data[user.email] === undefined) {
      gradesSynced.ignored.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'Project not found',
      });
      continue;
    }

    if (data[user.email] === -1) {
      gradesSynced.errors.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'No permission to retrieve grade',
      });
      continue;
    }

    if (data[user.email] === 0) {
      gradesSynced.ignored.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: 'No grades found',
      });
      continue;
    }

    try {
      const gradeObj = {
        // userId: token.user,
        userId: user.user_id,
        scoreGiven: data[user.email],
        scoreMaximum: 100,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
      };
      // Sending Grade
      // @ts-expect-error Outdated ltis @types.
      const responseGrade = await lti.Grade.submitScore(_token, lineItemId, gradeObj);
      if (responseGrade) {
        gradesSynced.success.push({
          row: JSON.stringify(user).replaceAll('\\', ''),
          message: `Grade synced: ${data[user.email]}%`,
        });
      }
    } catch (e) {
      console.error(`Unable to submit scores for ${user.name}`, e);
      gradesSynced.success.push({
        row: JSON.stringify(user).replaceAll('\\', ''),
        message: `Failed to submit score`,
      });
    }
  }

  return res.send(gradesSynced);
});

// Endpoint to set grade for single student
ltiRouter.post('/grade', async (req: Request, res: Response) => {
  const _token = res.locals.token;
  if (!_token) {
    return res.status(400).send({ error: 'Invalid Lti token' });
  }

  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;

  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).send({ error: 'No unit is linked to this course' });
  }

  const newToken = {
    unit_id: link.unitId,
  };

  const signedToken = jwt.sign(newToken, LTI_SHARED_API_SECRET);

  // TODO: signedToken as a query param or an Authorization header?
  const response = await fetch(`http://localhost:4200/api/lti/grade?ltik=${signedToken}`, {
    method: 'GET',
    headers: {
      // Authorization: String(req.headers['authorization'] ?? ''), //
      'Auth-Token': String(req.headers['auth-token'] ?? ''), // Forward OnTrack's original authorisation token
      Username: String(req.headers['username'] ?? ''),
    },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return res.status(response.status).json(errorBody);
  }

  const data = (await response.json()) as number | null;
  if (data === null || isNaN(data)) {
    return res.status(404);
  }

  let lineItemId = token.platformContext?.endpoint?.lineitem;

  if (!lineItemId) {
    // @ts-expect-error Outdated ltis @types.
    const response = await lti.Grade.getLineItems(_token, { resourceLinkId: true });
    const lineItems = response.lineItems;
    if (lineItems.length === 0) {
      // Creating line item if there is none
      const newLineItem = {
        scoreMaximum: 100,
        label: 'Grade',
        tag: 'grade',
        resourceLinkId: token.platformContext?.resource?.id,
        activityProgress: 'Completed',
        gradingProgress: 'FullyGraded',
      };
      // @ts-expect-error Outdated ltis @types.
      const lineItem = await lti.Grade.createLineItem(_token, newLineItem);
      lineItemId = lineItem.id;
    } else lineItemId = lineItems[0].id;
  }

  const members = await lti.NamesAndRoles.getMembers(_token);
  if (!members) {
    return res.status(400);
  }

  const gradeObj = {
    userId: token.user,
    scoreGiven: data,
    scoreMaximum: 100,
    activityProgress: 'Completed',
    gradingProgress: 'FullyGraded',
  };
  // Sending Grade
  // @ts-expect-error Outdated ltis @types.
  const responseGrade = await lti.Grade.submitScore(_token, lineItemId, gradeObj);

  return res.send(responseGrade);
});

ltiRouter.get('/members', async (req: Request, res: Response) => {
  const token = res.locals.token;
  if (!token) {
    return res.status(403).send({ error: 'Invalid Lti token' });
  }
  const members = await lti.NamesAndRoles.getMembers(token);
  return res.json(members);

  // if (result) {
  // https://community.canvaslms.com/t5/Developers-Group/LTI-1-3-mixing-roles/td-p/576665
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
  const _token = res.locals.token;

  // const contextId = req.query.contextId;
  const token = _token as unknown as LtiLaunchPayload;
  const contextId = token.platformContext?.context?.id;
  const link = await UnitLink.findOne({ contextId });
  res.json(link);
});

/*
 * Links a unit to an LMS context
 */
ltiRouter.post('/link', async (req: Request, res: Response) => {
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

  // Has our context been linked to an OnTrack unit?
  const link = await UnitLink.findOne({ contextId });
  if (!link) {
    return res.status(404).json({ error: 'Unit link not found' });
  }

  // TODO: check the roles of this incoming token

  const newToken = {
    unit_id: link?.unitId,
  };

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

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return res.status(response.status).json(errorBody);
  }

  const data = await response.json();

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
