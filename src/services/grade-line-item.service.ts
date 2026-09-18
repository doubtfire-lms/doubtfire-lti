import { HttpError } from 'ltijs';
import type { LaunchContext, LineItem, Platform } from 'ltijs';
import type { UnitLinkDocument } from '../schema/unitLink.model';
import {
  LtiServiceError,
  getPlatformAccessToken,
  platformErrorStatus,
  platformUrl,
} from './platform-access.service';

const GRADE_LINE_ITEM_LABEL = 'OnTrack';
const GRADE_LINE_ITEM_RESOURCE_ID = 'ontrack-portfolio-grade';
const GRADE_LINE_ITEM_TAG = 'ontrack-grade';
const AGS_LINEITEM_READONLY_SCOPE =
  'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly';
const AGS_LINEITEM_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/lineitem';
const AGS_SCORE_SCOPE = 'https://purl.imsglobal.org/spec/lti-ags/scope/score';
const LINEITEM_ACCEPT = 'application/vnd.ims.lis.v2.lineitem+json';
const LINEITEM_CONTAINER_ACCEPT = 'application/vnd.ims.lis.v2.lineitemcontainer+json';
const MAXIMUM_LINE_ITEM_PAGES = 100;

class GradeLineItemError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const GRADE_SERVICE_SETTING_HINT =
  "In Moodle, edit the OnTrack external tool and set 'IMS LTI Assignment and Grade Services' to 'Use this service for grade sync and column management', then relaunch OnTrack and retry.";

const GRADE_SERVICE_NOT_ENABLED_MESSAGE = `Grade sync has not been enabled for the OnTrack LTI tool. ${GRADE_SERVICE_SETTING_HINT}`;

export type GradeLineItemUnavailableReason =
  'service_not_enabled' | 'line_item_missing' | 'line_item_unavailable';

export interface GradeLineItemStatus {
  configured: boolean;
  visibility: 'unknown';
  reason?: GradeLineItemUnavailableReason;
  message?: string;
  lineItem?: {
    id: string;
    label: string;
    scoreMaximum: number;
  };
}

function oauthErrorCode(error: HttpError): string | undefined {
  const response = error.response;
  if (!response || typeof response !== 'object') return undefined;
  const code = (response as Record<string, unknown>).error;
  return typeof code === 'string' ? code : undefined;
}

export function gradeLineItemErrorStatus(error: unknown): number {
  if (error instanceof GradeLineItemError) return error.status;
  if (error instanceof LtiServiceError) return error.status;
  if (error instanceof HttpError && oauthErrorCode(error)) return 422;
  return error instanceof HttpError && error.status ? error.status : 502;
}

export function gradeLineItemErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof GradeLineItemError || error instanceof LtiServiceError) {
    return error.message;
  }
  if (error instanceof HttpError) {
    const code = oauthErrorCode(error);
    if (code === 'invalid_scope') {
      return `Moodle has not granted OnTrack permission to manage grade columns. ${GRADE_SERVICE_SETTING_HINT}`;
    }
    if (code) {
      return `Moodle refused OnTrack's access token request (${code}). Check that the OnTrack tool's public keyset URL is reachable from Moodle.`;
    }
    return `${fallback}: Moodle responded ${error.status ?? ''} ${error.statusText ?? ''}`.trim();
  }
  return error instanceof Error ? error.message : fallback;
}

async function getResourceLinkLineItems(launchContext: LaunchContext): Promise<LineItem[]> {
  if (!launchContext.grading.isAvailable()) {
    throw new GradeLineItemError(
      `Assignment and Grade Services are unavailable for this launch. ${GRADE_SERVICE_SETTING_HINT}`,
      422,
    );
  }

  const maximumPages = 100;
  const lineItems: LineItem[] = [];
  const visitedPages = new Set<string>();
  let page = await launchContext.grading.getLineItems({ resourceLinkId: true });
  lineItems.push(...page.lineItems);

  while (page.next) {
    const nextPageUrl = page.next;

    if (visitedPages.has(nextPageUrl)) {
      throw new GradeLineItemError('Moodle returned a circular line-item pagination link', 502);
    }
    visitedPages.add(nextPageUrl);
    if (visitedPages.size >= maximumPages) {
      throw new GradeLineItemError(
        `Moodle returned more than ${maximumPages} pages of line items`,
        502,
      );
    }
    page = await launchContext.grading.getLineItems({ url: nextPageUrl });
    lineItems.push(...page.lineItems);
  }

  return lineItems;
}

export async function findStoredGradeLineItem(
  launchContext: LaunchContext,
  lineItemId: string,
): Promise<LineItem | undefined> {
  const lineItems = await getResourceLinkLineItems(launchContext);
  return lineItems.find((lineItem) => lineItem.id === lineItemId);
}

function advertisedScopes(link: UnitLinkDocument): Set<string> {
  return new Set(link.agsScopes ?? []);
}

async function gradeAccessToken(platform: Platform, scopes: readonly string[]) {
  try {
    return await getPlatformAccessToken(platform, scopes);
  } catch (error) {
    if (error instanceof LtiServiceError && error.message.includes(': invalid_scope')) {
      throw new GradeLineItemError(GRADE_SERVICE_NOT_ENABLED_MESSAGE, 422);
    }
    throw error;
  }
}

function hasGradeSyncService(link: UnitLinkDocument): boolean {
  const scopes = advertisedScopes(link);
  return (
    scopes.has(AGS_SCORE_SCOPE) &&
    scopes.has(AGS_LINEITEM_READONLY_SCOPE) &&
    Boolean(link.claimedLineItemId || (link.lineItemsUrl && link.resourceLinkId))
  );
}

function lineItemFromBody(body: unknown, description: string): LineItem {
  if (!body || typeof body !== 'object') {
    throw new GradeLineItemError(`Moodle returned an invalid ${description}`, 502);
  }
  const item = body as Record<string, unknown>;
  if (
    typeof item.id !== 'string' ||
    !item.id ||
    typeof item.label !== 'string' ||
    typeof item.scoreMaximum !== 'number' ||
    !Number.isFinite(item.scoreMaximum)
  ) {
    throw new GradeLineItemError(`Moodle returned an invalid ${description}`, 502);
  }
  return item as LineItem;
}

async function fetchLineItemById(
  platform: Platform,
  lineItemId: string,
  authorization: string,
): Promise<LineItem | undefined> {
  const url = platformUrl(lineItemId, platform, 'grade line item');
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: LINEITEM_ACCEPT, Authorization: authorization },
    });
  } catch (error) {
    throw new LtiServiceError(
      `Unable to reach the LMS for grade line item: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) return undefined;
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new LtiServiceError(
      `The LMS rejected the grade line item request (${response.status})`,
      platformErrorStatus(response.status),
    );
  }
  return lineItemFromBody(body, 'grade line item');
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return undefined;
}

async function findCanonicalLineItem(
  link: UnitLinkDocument,
  platform: Platform,
  authorization: string,
): Promise<LineItem | undefined> {
  if (!link.lineItemsUrl || !link.resourceLinkId) return undefined;

  const firstPage = platformUrl(link.lineItemsUrl, platform, 'grade line items');
  firstPage.searchParams.set('resource_link_id', link.resourceLinkId);
  const canonicalLineItems: LineItem[] = [];
  const visitedPages = new Set<string>();
  let pageUrl: URL | undefined = firstPage;

  for (let page = 0; pageUrl && page < MAXIMUM_LINE_ITEM_PAGES; page++) {
    const pageKey = pageUrl.toString();
    if (visitedPages.has(pageKey)) {
      throw new GradeLineItemError('Moodle returned a circular line-item pagination link', 502);
    }
    visitedPages.add(pageKey);

    let response: Response;
    try {
      response = await fetch(pageUrl, {
        headers: { Accept: LINEITEM_CONTAINER_ACCEPT, Authorization: authorization },
      });
    } catch (error) {
      throw new LtiServiceError(
        `Unable to reach the LMS for grade line items: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new LtiServiceError(
        `The LMS rejected the grade line items request (${response.status})`,
        platformErrorStatus(response.status),
      );
    }
    if (!Array.isArray(body)) {
      throw new GradeLineItemError('Moodle returned an invalid grade line-item collection', 502);
    }
    for (const rawItem of body) {
      const item = lineItemFromBody(rawItem, 'grade line item');
      if (item.resourceId === GRADE_LINE_ITEM_RESOURCE_ID || item.tag === GRADE_LINE_ITEM_TAG) {
        canonicalLineItems.push(item);
      }
    }

    const next = nextLink(response.headers.get('link'));
    pageUrl = next ? platformUrl(next, platform, 'grade line items') : undefined;
  }

  if (pageUrl) {
    throw new GradeLineItemError(
      `Moodle returned more than ${MAXIMUM_LINE_ITEM_PAGES} pages of line items`,
      502,
    );
  }
  if (canonicalLineItems.length > 1) {
    throw new GradeLineItemError(
      'Multiple OnTrack grade line items exist for this Moodle activity',
      409,
    );
  }
  return canonicalLineItems[0];
}

async function createStoredGradeLineItem(
  link: UnitLinkDocument,
  platform: Platform,
): Promise<LineItem> {
  if (!link.lineItemsUrl || !link.resourceLinkId) {
    throw new GradeLineItemError(GRADE_SERVICE_NOT_ENABLED_MESSAGE, 422);
  }
  if (!advertisedScopes(link).has(AGS_LINEITEM_SCOPE)) {
    throw new GradeLineItemError(GRADE_SERVICE_NOT_ENABLED_MESSAGE, 422);
  }

  const token = await gradeAccessToken(platform, [AGS_LINEITEM_SCOPE]);
  const url = platformUrl(link.lineItemsUrl, platform, 'grade line items');
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: LINEITEM_ACCEPT,
        'Content-Type': LINEITEM_ACCEPT,
        Authorization: token.authorization,
      },
      body: JSON.stringify({
        label: GRADE_LINE_ITEM_LABEL,
        scoreMaximum: 100,
        resourceId: GRADE_LINE_ITEM_RESOURCE_ID,
        resourceLinkId: link.resourceLinkId,
        tag: GRADE_LINE_ITEM_TAG,
      }),
    });
  } catch (error) {
    throw new LtiServiceError(
      `Unable to reach the LMS to create the grade line item: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? GRADE_SERVICE_NOT_ENABLED_MESSAGE
        : `Moodle rejected the grade line-item creation request (${response.status})`;
    throw new GradeLineItemError(message, platformErrorStatus(response.status));
  }
  const lineItem = lineItemFromBody(body, 'created grade line item');
  platformUrl(lineItem.id!, platform, 'created grade line item');
  return lineItem;
}

export async function ensureStoredGradeLineItem(
  link: UnitLinkDocument,
  platform: Platform,
): Promise<GradeLineItemStatus> {
  if (!hasGradeSyncService(link)) {
    throw new GradeLineItemError(GRADE_SERVICE_NOT_ENABLED_MESSAGE, 422);
  }

  const readToken = await gradeAccessToken(platform, [AGS_LINEITEM_READONLY_SCOPE]);
  const candidateIds = [link.lineItemId, link.claimedLineItemId].filter(
    (value, index, values): value is string =>
      typeof value === 'string' && value.length > 0 && values.indexOf(value) === index,
  );
  let lineItem: LineItem | undefined;
  for (const candidateId of candidateIds) {
    lineItem = await fetchLineItemById(platform, candidateId, readToken.authorization);
    if (lineItem) break;
  }
  lineItem ??= await findCanonicalLineItem(link, platform, readToken.authorization);
  lineItem ??= await createStoredGradeLineItem(link, platform);

  platformUrl(lineItem.id!, platform, 'grade line item');
  link.lineItemId = lineItem.id!;
  await link.save();
  return {
    configured: true,
    visibility: 'unknown',
    lineItem: {
      id: lineItem.id!,
      label: lineItem.label,
      scoreMaximum: lineItem.scoreMaximum,
    },
  };
}

export async function storedGradeLineItemStatus(
  link: UnitLinkDocument,
  platform: Platform,
): Promise<GradeLineItemStatus> {
  if (!hasGradeSyncService(link)) {
    return {
      configured: false,
      visibility: 'unknown',
      reason: 'service_not_enabled',
      message: GRADE_SERVICE_NOT_ENABLED_MESSAGE,
    };
  }
  if (!link.lineItemId) {
    const message = advertisedScopes(link).has(AGS_LINEITEM_SCOPE)
      ? 'No Moodle grade item is linked yet. Retry to find or create it.'
      : GRADE_SERVICE_NOT_ENABLED_MESSAGE;
    return {
      configured: false,
      visibility: 'unknown',
      reason: 'line_item_missing',
      message,
    };
  }

  try {
    const token = await gradeAccessToken(platform, [AGS_LINEITEM_READONLY_SCOPE]);
    const lineItem = await fetchLineItemById(platform, link.lineItemId, token.authorization);
    if (!lineItem) {
      return {
        configured: false,
        visibility: 'unknown',
        reason: 'line_item_unavailable',
        message: 'The linked Moodle grade item is no longer available. Retry to find or create it.',
      };
    }
    return {
      configured: true,
      visibility: 'unknown',
      lineItem: {
        id: lineItem.id!,
        label: lineItem.label,
        scoreMaximum: lineItem.scoreMaximum,
      },
    };
  } catch (error) {
    return {
      configured: false,
      visibility: 'unknown',
      reason: 'line_item_unavailable',
      message: gradeLineItemErrorMessage(error, 'Unable to validate the linked Moodle grade item'),
    };
  }
}
