import type { LaunchContext } from 'ltijs';

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

export function ltiResourceId(launchContext: LaunchContext): string | undefined {
  return stringClaim(launchContext.idToken.launch.resource, 'id');
}

export function isStaffLaunch(roles: readonly string[]): boolean {
  return roles.some((role) =>
    /(?:#|\/)(Instructor|TeachingAssistant|Administrator|ContentDeveloper|Manager)$/.test(role),
  );
}
