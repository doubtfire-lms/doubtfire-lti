import jwt from 'jsonwebtoken';
import type { LaunchContext, Platform } from 'ltijs';
import crypto from 'node:crypto';
import { ltiContextId, stringClaim } from '../lti-claims';
import MoodleCourseConnection from '../schema/moodleCourseConnection.model';

export const MOODLE_COURSE_DATA_URL_CLAIM = 'ontrack_course_data_url';
export const MOODLE_COURSE_DATA_SCOPE_CLAIM = 'ontrack_course_data_scope';
export const MOODLE_COURSE_DATA_READ_SCOPE =
  'https://ontrack.edu.au/lti/scope/course-data.readonly';
export const MOODLE_COURSE_DATA_MEDIA_TYPE = 'application/vnd.ontrack.course-data.v2+json';
export const MOODLE_COURSE_DATA_SECTIONS = ['users', 'groups', 'assignments'] as const;

export type MoodleCourseDataSection = (typeof MOODLE_COURSE_DATA_SECTIONS)[number];

export interface MoodleCourseDataRequest {
  assignmentId?: string;
  include?: readonly MoodleCourseDataSection[];
}

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface MoodleCourseUserRole {
  id: string;
  short_name: string;
  name: string;
  archetype: string;
}

export interface MoodleCourseUserEnrolment {
  id: string;
  instance_id: string;
  method: string;
  instance_name: string;
  status: number;
  instance_status: number;
  start_date: number;
  end_date: number;
  active: boolean;
}

export interface MoodleCourseUser {
  id: string;
  username: string;
  idnumber: string;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string;
  suspended: boolean;
  deleted: boolean;
  roles: MoodleCourseUserRole[];
  enrolments: MoodleCourseUserEnrolment[];
}

export interface MoodleCourseGroup {
  id: string;
  idnumber: string;
  name: string;
  visibility: number;
  participation: boolean;
  grouping_ids: string[];
  member_user_ids: string[];
}

export interface MoodleAssignmentExtension {
  user_id: string;
  extension_due_date: number;
}

export interface MoodleAssignmentUserOverride {
  user_id: string;
  allows_submissions_from_date: number | null;
  due_date: number | null;
  cutoff_date: number | null;
}

export interface MoodleAssignmentGroupOverride {
  group_id: string;
  allows_submissions_from_date: number | null;
  due_date: number | null;
  cutoff_date: number | null;
}

export interface MoodleCourseAssignment {
  id: string;
  course_module_id: string;
  name: string;
  allows_submissions_from_date: number;
  due_date: number;
  cutoff_date: number;
  grading_due_date: number;
  accepts_submissions: boolean;
  visible: boolean;
  visible_on_course_page: boolean;
  extensions: MoodleAssignmentExtension[];
  user_overrides: MoodleAssignmentUserOverride[];
  group_overrides: MoodleAssignmentGroupOverride[];
}

export interface MoodleCourseDataSnapshot {
  version: '2';
  generated_at: number;
  context: {
    id: string;
    label: string;
    title: string;
    start_date: number;
    end_date: number;
  };
  users?: MoodleCourseUser[];
  groups?: MoodleCourseGroup[];
  assignments?: MoodleCourseAssignment[];
}

interface AccessTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface CourseDataConfiguration {
  endpoint: URL;
  scope: string;
}

export class MoodleCourseDataServiceError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = 'MoodleCourseDataServiceError';
  }
}

export function courseDataSectionsFrom(value: unknown): MoodleCourseDataSection[] | undefined {
  if (value === undefined) return undefined;

  const requested =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value) && value.every((section) => typeof section === 'string')
        ? value
        : [];
  if (
    requested.length === 0 ||
    requested.some((section) => !section) ||
    new Set(requested).size !== requested.length ||
    requested.some(
      (section) => !MOODLE_COURSE_DATA_SECTIONS.includes(section as MoodleCourseDataSection),
    )
  ) {
    throw new MoodleCourseDataServiceError(
      'include must contain unique values from users, groups, assignments',
      400,
    );
  }

  return MOODLE_COURSE_DATA_SECTIONS.filter((section) => requested.includes(section));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string';
}

function isCourseUser(value: unknown): value is MoodleCourseUser {
  return (
    isObject(value) &&
    hasString(value, 'id') &&
    hasString(value, 'username') &&
    Array.isArray(value.roles) &&
    Array.isArray(value.enrolments)
  );
}

function isCourseGroup(value: unknown): value is MoodleCourseGroup {
  return (
    isObject(value) &&
    hasString(value, 'id') &&
    hasString(value, 'name') &&
    Array.isArray(value.grouping_ids) &&
    Array.isArray(value.member_user_ids)
  );
}

function isCourseAssignment(value: unknown): value is MoodleCourseAssignment {
  return (
    isObject(value) &&
    hasString(value, 'id') &&
    hasString(value, 'name') &&
    typeof value.due_date === 'number' &&
    Array.isArray(value.extensions) &&
    Array.isArray(value.user_overrides) &&
    Array.isArray(value.group_overrides)
  );
}

function parseSnapshot(value: unknown, request: MoodleCourseDataRequest): MoodleCourseDataSnapshot {
  if (!isObject(value) || value.version !== '2' || !isObject(value.context)) {
    throw new MoodleCourseDataServiceError(
      'Moodle returned an invalid OnTrack course-data response',
    );
  }
  if (
    !hasString(value.context, 'id') ||
    !hasString(value.context, 'label') ||
    !hasString(value.context, 'title')
  ) {
    throw new MoodleCourseDataServiceError(
      'Moodle returned an invalid OnTrack course-data response',
    );
  }

  const included = request.include ?? MOODLE_COURSE_DATA_SECTIONS;
  const validSections = included.every((section) => {
    const sectionValue = value[section];
    if (!Array.isArray(sectionValue)) return false;
    if (section === 'users') return sectionValue.every(isCourseUser);
    if (section === 'groups') return sectionValue.every(isCourseGroup);
    return sectionValue.every(isCourseAssignment);
  });
  if (!validSections) {
    throw new MoodleCourseDataServiceError(
      'Moodle returned an invalid OnTrack course-data response',
    );
  }

  return value as unknown as MoodleCourseDataSnapshot;
}

function validateEndpoint(endpointValue: string, platformUrl: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new MoodleCourseDataServiceError(
      'Moodle advertised an invalid OnTrack course-data URL',
      422,
    );
  }

  if (endpoint.origin !== new URL(platformUrl).origin) {
    throw new MoodleCourseDataServiceError(
      'The Moodle OnTrack course-data URL does not match the registered platform origin',
      422,
    );
  }
  return endpoint;
}

export function courseDataConfigurationFromLaunch(
  launchContext: LaunchContext,
): CourseDataConfiguration {
  const custom = launchContext.idToken.launch.custom;
  const endpointValue = stringClaim(custom, MOODLE_COURSE_DATA_URL_CLAIM);
  const scope = stringClaim(custom, MOODLE_COURSE_DATA_SCOPE_CLAIM);
  if (!endpointValue || !scope) {
    throw new MoodleCourseDataServiceError(
      'The Moodle OnTrack course-data plugin is not enabled for this external tool. Enable it and perform a fresh LTI launch.',
      422,
    );
  }
  if (scope !== MOODLE_COURSE_DATA_READ_SCOPE) {
    throw new MoodleCourseDataServiceError(
      'Moodle advertised an unsupported OnTrack course-data scope',
      422,
    );
  }

  return {
    endpoint: validateEndpoint(endpointValue, launchContext.platform.url),
    scope,
  };
}

async function requestAccessToken(platform: Platform, scope: string): Promise<AccessTokenResponse> {
  const assertion = jwt.sign(
    {
      sub: platform.clientId,
      iss: platform.clientId,
      aud: platform.authorizationServer,
      jti: crypto.randomUUID(),
    },
    platform.keys.private,
    {
      algorithm: 'RS256',
      expiresIn: 60,
      keyid: platform.id,
    },
  );
  const response = await fetch(platform.accessTokenEndpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: assertion,
      scope,
    }),
  });
  const payload = (await response.json().catch(() => null)) as Partial<AccessTokenResponse> | null;
  if (!response.ok || !payload?.access_token || !payload.token_type || !payload.expires_in) {
    throw new MoodleCourseDataServiceError(
      `Moodle did not issue an access token for the OnTrack course-data scope (${response.status})`,
      response.status >= 400 && response.status < 500 ? 422 : 502,
    );
  }

  return payload as AccessTokenResponse;
}

export async function fetchMoodleCourseData(
  platform: Platform,
  configuration: CourseDataConfiguration,
  request: MoodleCourseDataRequest = {},
): Promise<MoodleCourseDataSnapshot> {
  if (configuration.scope !== MOODLE_COURSE_DATA_READ_SCOPE) {
    throw new MoodleCourseDataServiceError('Stored Moodle course-data scope is unsupported', 422);
  }
  if (request.assignmentId && request.include && !request.include.includes('assignments')) {
    throw new MoodleCourseDataServiceError('assignmentId requires assignments to be included', 400);
  }
  const endpoint = validateEndpoint(configuration.endpoint.toString(), platform.url);
  if (request.include) endpoint.searchParams.set('include', request.include.join(','));
  if (request.assignmentId) endpoint.searchParams.set('assignment_id', request.assignmentId);

  const accessToken = await requestAccessToken(platform, configuration.scope);
  const response = await fetch(endpoint, {
    headers: {
      Accept: MOODLE_COURSE_DATA_MEDIA_TYPE,
      Authorization: `${accessToken.token_type} ${accessToken.access_token}`,
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new MoodleCourseDataServiceError(
      `Moodle OnTrack course-data request failed (${response.status})`,
      response.status >= 400 && response.status < 500 ? 422 : 502,
    );
  }

  return parseSnapshot(payload, request);
}

export async function getMoodleCourseData(
  launchContext: LaunchContext,
  request: MoodleCourseDataRequest = {},
): Promise<MoodleCourseDataSnapshot> {
  return fetchMoodleCourseData(
    launchContext.platform,
    courseDataConfigurationFromLaunch(launchContext),
    request,
  );
}

export async function rememberMoodleCourseConnection(launchContext: LaunchContext) {
  const contextId = ltiContextId(launchContext);
  if (!contextId) {
    throw new MoodleCourseDataServiceError('LTI launch does not include a context ID', 400);
  }
  const configuration = courseDataConfigurationFromLaunch(launchContext);
  const context = launchContext.idToken.launch.context;
  return MoodleCourseConnection.findOneAndUpdate(
    { contextId },
    {
      $set: {
        contextLabel: stringClaim(context, 'label'),
        contextTitle: stringClaim(context, 'title'),
        platformId: launchContext.platform.id,
        endpoint: configuration.endpoint.toString(),
        scope: configuration.scope,
      },
    },
    { upsert: true, new: true },
  );
}

export async function fetchStoredMoodleCourseData(
  connection: {
    platformId: string;
    endpoint: string;
    scope: string;
  },
  platform: Platform,
  request: MoodleCourseDataRequest = {},
): Promise<MoodleCourseDataSnapshot> {
  if (platform.id !== connection.platformId) {
    throw new MoodleCourseDataServiceError('Stored Moodle platform does not match the course', 422);
  }
  return fetchMoodleCourseData(
    platform,
    { endpoint: new URL(connection.endpoint), scope: connection.scope },
    request,
  );
}

export function selectedAssignmentData(
  snapshot: MoodleCourseDataSnapshot,
  selectedAssignmentId?: string | null,
) {
  const assignment = selectedAssignmentId
    ? (snapshot.assignments?.find((candidate) => candidate.id === selectedAssignmentId) ?? null)
    : null;
  return {
    assignment,
    extensions:
      assignment?.extensions.map((extension) => ({
        ...extension,
        assignment_id: assignment.id,
        assignment_name: assignment.name,
        assignment_due_date: assignment.due_date,
      })) ?? [],
  };
}
