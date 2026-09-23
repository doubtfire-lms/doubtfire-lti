import type { LaunchContext } from 'ltijs';
import { Config } from './config';

const LIS_CLAIM = 'https://purl.imsglobal.org/spec/lti/claim/lis';

export function stringClaim(
  claims: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const value = claims?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

export function stringArrayClaim(
  claims: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string[] | undefined {
  const value = claims?.[key];
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
    ? value
    : undefined;
}

export function ltiContextId(launchContext: LaunchContext): string | undefined {
  return stringClaim(launchContext.idToken.launch.context, 'id');
}

/** Course page in the LMS, from the PLATFORM_COURSE_URL template configured for this platform. */
export function ltiCourseUrl(contextId: string | undefined | null): string | undefined {
  const template = Config.PLATFORM_COURSE_URL;
  if (!template || !contextId) return undefined;

  try {
    const url = new URL(template.replace('{COURSE_ID}', encodeURIComponent(contextId)));
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function ltiResourceId(launchContext: LaunchContext): string | undefined {
  return stringClaim(launchContext.idToken.launch.resource, 'id');
}

/** The launch user's LIS person sourcedid, which Moodle fills from the user's ID number. */
export function ltiPersonSourcedId(launchContext: LaunchContext): string | undefined {
  const claim = launchContext.rawIdToken[LIS_CLAIM] as Record<string, unknown> | undefined;
  return stringClaim(claim, 'person_sourcedid');
}

export function isStaffLaunch(roles: readonly string[]): boolean {
  return roles.some((role) =>
    /(?:#|\/)(Instructor|TeachingAssistant|Administrator|ContentDeveloper|Manager)$/.test(role),
  );
}
