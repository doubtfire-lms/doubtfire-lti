import type { LaunchContext, Platform } from 'ltijs';
import { stringClaim } from '../lti-claims';
import { lti } from '../lti-provider';
import type { UnitLinkDocument } from '../schema/unitLink.model';
import {
  courseDataConfigurationFromLaunch,
  fetchStoredMoodleCourseData,
} from './moodle-course-data.service';
import {
  LtiServiceError,
  getPlatformAccessToken,
  platformErrorStatus,
  platformUrl,
} from './platform-access.service';

const NRPS_CLAIM = 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice';
const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
const NRPS_ACCEPT = 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json';
const AGS_LINEITEM_READONLY_SCOPE =
  'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly';
const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
const LINEITEM_ACCEPT = 'application/vnd.ims.lis.v2.lineitem+json';
const SCORE_CONTENT_TYPE = 'application/vnd.ims.lis.v1.score+json';
const MAX_MEMBERSHIP_PAGES = 100;

export interface LmsMember {
  user_id: string;
  status?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  roles: string[];
  [claim: string]: unknown;
}

export interface LmsMembership {
  context?: { id?: string; label?: string; title?: string };
  members: LmsMember[];
}

export interface LmsLineItem {
  id: string;
  label?: string;
  scoreMaximum?: number;
}

export interface LmsScore {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  activityProgress: string;
  gradingProgress: string;
  timestamp: string;
}

function membershipsUrlFromLaunch(launchContext: LaunchContext): string | undefined {
  const claim = launchContext.rawIdToken[NRPS_CLAIM] as Record<string, unknown> | undefined;
  return stringClaim(claim, 'context_memberships_url');
}

/**
 * Stores the service details from a signed launch on its unit link. The course-data plugin is
 * probed with a real request so OnTrack only offers plugin features that actually work.
 */
export async function refreshLinkFromLaunch(
  link: UnitLinkDocument,
  launchContext: LaunchContext,
  { probeCourseData }: { probeCourseData: boolean },
): Promise<UnitLinkDocument> {
  const context = launchContext.idToken.launch.context;
  link.platformId = launchContext.platform.id;
  link.contextLabel = stringClaim(context, 'label') ?? link.contextLabel ?? null;
  link.contextTitle = stringClaim(context, 'title') ?? link.contextTitle ?? null;
  link.membershipsUrl = membershipsUrlFromLaunch(launchContext) ?? null;

  let configuration;
  try {
    configuration = courseDataConfigurationFromLaunch(launchContext);
  } catch {
    configuration = undefined;
  }
  link.courseDataEndpoint = configuration?.endpoint.toString() ?? null;
  link.courseDataScope = configuration?.scope ?? null;

  if (!configuration) {
    link.courseDataAvailable = false;
    link.capabilitiesCheckedAt = new Date();
  } else if (probeCourseData) {
    try {
      await fetchStoredMoodleCourseData(link, launchContext.platform, { include: ['groups'] });
      link.courseDataAvailable = true;
    } catch (error) {
      link.courseDataAvailable = false;
      console.error(
        JSON.stringify({
          event: 'moodle_course_data_probe_failure',
          contextId: link.contextId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    link.capabilitiesCheckedAt = new Date();
  }

  return link.save();
}

export async function platformForLink(link: UnitLinkDocument): Promise<Platform> {
  if (!link.platformId) {
    throw new LtiServiceError(
      'This link has no stored LMS platform. Relaunch OnTrack from the LMS to refresh it.',
      409,
    );
  }
  const platform = await lti.platformManager.getPlatformById(link.platformId);
  if (!platform) {
    throw new LtiServiceError('The registered LMS platform for this link was not found', 409);
  }
  return platform;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return undefined;
}

async function platformRequest(
  url: URL,
  init: RequestInit,
  description: string,
): Promise<{ response: Response; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new LtiServiceError(
      `Unable to reach the LMS for ${description}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new LtiServiceError(
      `The LMS rejected the ${description} request (${response.status})`,
      platformErrorStatus(response.status),
    );
  }
  return { response, body };
}

/** Retrieves course members through Names and Role Provisioning using the stored memberships URL. */
export async function fetchLinkMembers(
  link: UnitLinkDocument,
  platform: Platform,
  { limit }: { limit?: number } = {},
): Promise<LmsMembership> {
  if (!link.membershipsUrl) {
    throw new LtiServiceError(
      'Names and Role Provisioning is not available for this course. Enable it for the external tool and relaunch OnTrack from the LMS.',
      422,
    );
  }

  const token = await getPlatformAccessToken(platform, [NRPS_SCOPE]);
  const firstPage = platformUrl(link.membershipsUrl, platform, 'memberships');
  if (limit) firstPage.searchParams.set('limit', String(limit));

  const membership: LmsMembership = { members: [] };
  let pageUrl: URL | undefined = firstPage;
  for (let page = 0; pageUrl && page < MAX_MEMBERSHIP_PAGES; page++) {
    const { response, body } = await platformRequest(
      pageUrl,
      { headers: { Accept: NRPS_ACCEPT, Authorization: token.authorization } },
      'course membership',
    );
    const container = body as Partial<LmsMembership> | null;
    if (!container || !Array.isArray(container.members)) {
      throw new LtiServiceError('The LMS returned an invalid course membership response');
    }
    if (!membership.context && container.context) membership.context = container.context;
    membership.members.push(...container.members);

    if (limit) break;
    const next = nextLink(response.headers.get('link'));
    pageUrl = next ? platformUrl(next, platform, 'memberships') : undefined;
  }
  return membership;
}

export async function fetchLinkLineItem(
  link: UnitLinkDocument,
  platform: Platform,
): Promise<LmsLineItem | undefined> {
  if (!link.lineItemId) return undefined;

  const token = await getPlatformAccessToken(platform, [AGS_LINEITEM_READONLY_SCOPE]);
  const url = platformUrl(link.lineItemId, platform, 'grade line item');
  try {
    const { body } = await platformRequest(
      url,
      { headers: { Accept: LINEITEM_ACCEPT, Authorization: token.authorization } },
      'grade line item',
    );
    return body as LmsLineItem;
  } catch (error) {
    if (error instanceof LtiServiceError && error.status === 422) return undefined;
    throw error;
  }
}

export async function submitLinkScore(
  link: UnitLinkDocument,
  platform: Platform,
  score: LmsScore,
): Promise<void> {
  if (!link.lineItemId) {
    throw new LtiServiceError('No grade line item is linked to this course', 409);
  }

  const token = await getPlatformAccessToken(platform, [AGS_SCORE_SCOPE]);
  const url = platformUrl(link.lineItemId, platform, 'grade line item');
  url.pathname = `${url.pathname}/scores`;
  await platformRequest(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': SCORE_CONTENT_TYPE, Authorization: token.authorization },
      body: JSON.stringify(score),
    },
    'score submission',
  );
}
