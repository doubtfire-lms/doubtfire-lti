import type { LaunchContext, Platform } from 'ltijs';
import { stringClaim } from '../lti-claims';
import {
  LtiServiceError,
  getPlatformAccessToken,
  platformErrorStatus,
  platformUrl,
} from './platform-access.service';

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

export interface CourseDataConfiguration {
  endpoint: URL;
  scope: string;
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
    throw new LtiServiceError(
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
    throw new LtiServiceError('Moodle returned an invalid OnTrack course-data response');
  }
  if (
    !hasString(value.context, 'id') ||
    !hasString(value.context, 'label') ||
    !hasString(value.context, 'title')
  ) {
    throw new LtiServiceError('Moodle returned an invalid OnTrack course-data response');
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
    throw new LtiServiceError('Moodle returned an invalid OnTrack course-data response');
  }

  return value as unknown as MoodleCourseDataSnapshot;
}

export function courseDataConfigurationFromLaunch(
  launchContext: LaunchContext,
): CourseDataConfiguration {
  const custom = launchContext.idToken.launch.custom;
  const endpointValue = stringClaim(custom, MOODLE_COURSE_DATA_URL_CLAIM);
  const scope = stringClaim(custom, MOODLE_COURSE_DATA_SCOPE_CLAIM);
  if (!endpointValue || !scope) {
    throw new LtiServiceError(
      'The Moodle OnTrack course-data plugin is not enabled for this external tool. Enable it and perform a fresh LTI launch.',
      422,
    );
  }
  if (scope !== MOODLE_COURSE_DATA_READ_SCOPE) {
    throw new LtiServiceError('Moodle advertised an unsupported OnTrack course-data scope', 422);
  }

  return {
    endpoint: platformUrl(endpointValue, launchContext.platform, 'Moodle course-data'),
    scope,
  };
}

export async function fetchMoodleCourseData(
  platform: Platform,
  configuration: CourseDataConfiguration,
  request: MoodleCourseDataRequest = {},
): Promise<MoodleCourseDataSnapshot> {
  if (configuration.scope !== MOODLE_COURSE_DATA_READ_SCOPE) {
    throw new LtiServiceError('Stored Moodle course-data scope is unsupported', 422);
  }
  if (request.assignmentId && request.include && !request.include.includes('assignments')) {
    throw new LtiServiceError('assignmentId requires assignments to be included', 400);
  }
  const endpoint = platformUrl(configuration.endpoint.toString(), platform, 'Moodle course-data');
  if (request.include) endpoint.searchParams.set('include', request.include.join(','));
  if (request.assignmentId) endpoint.searchParams.set('assignment_id', request.assignmentId);

  const accessToken = await getPlatformAccessToken(platform, [configuration.scope]);
  const response = await fetch(endpoint, {
    headers: {
      Accept: MOODLE_COURSE_DATA_MEDIA_TYPE,
      Authorization: accessToken.authorization,
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new LtiServiceError(
      `Moodle OnTrack course-data request failed (${response.status})`,
      platformErrorStatus(response.status),
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

export async function fetchStoredMoodleCourseData(
  link: {
    platformId?: string | null;
    courseDataEndpoint?: string | null;
    courseDataScope?: string | null;
  },
  platform: Platform,
  request: MoodleCourseDataRequest = {},
): Promise<MoodleCourseDataSnapshot> {
  if (!link.courseDataEndpoint || !link.courseDataScope) {
    throw new LtiServiceError(
      'The Moodle OnTrack course-data plugin has not been detected for this course. Enable it for the external tool and relaunch OnTrack from Moodle.',
      422,
    );
  }
  if (platform.id !== link.platformId) {
    throw new LtiServiceError('Stored Moodle platform does not match the course', 422);
  }
  return fetchMoodleCourseData(
    platform,
    { endpoint: new URL(link.courseDataEndpoint), scope: link.courseDataScope },
    request,
  );
}
