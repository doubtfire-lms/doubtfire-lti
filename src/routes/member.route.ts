import express, { Request, Response } from 'express';
import { Provider as lti } from 'ltijs';
import { LtiLaunchPayload } from '../types';

export const MemberRoute = express.Router();

/*
 * Retrieves token information
 */
MemberRoute.get('/info', async (_req: Request, res: Response) => {
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
    custom?: object;
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

MemberRoute.get('/members', async (req: Request, res: Response) => {
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
