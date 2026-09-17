import { HttpError } from 'ltijs';
import type { LaunchContext, LineItem } from 'ltijs';
import { ltiResourceId } from '../lti-claims';

const GRADE_LINE_ITEM_LABEL = 'OnTrack';
const GRADE_LINE_ITEM_RESOURCE_ID = 'ontrack-portfolio-grade';
const GRADE_LINE_ITEM_TAG = 'ontrack-grade';

class GradeLineItemError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const GRADE_SERVICE_SETTING_HINT =
  "In Moodle, edit the OnTrack external tool and set 'IMS LTI Assignment and Grade Services' to 'Use this service for grade sync and column management', then relaunch OnTrack.";

function oauthErrorCode(error: HttpError): string | undefined {
  const response = error.response;
  if (!response || typeof response !== 'object') return undefined;
  const code = (response as Record<string, unknown>).error;
  return typeof code === 'string' ? code : undefined;
}

export function gradeLineItemErrorStatus(error: unknown): number {
  if (error instanceof GradeLineItemError) return error.status;
  if (error instanceof HttpError && oauthErrorCode(error)) return 422;
  return error instanceof HttpError && error.status ? error.status : 502;
}

export function gradeLineItemErrorMessage(error: unknown, fallback: string): string {
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

export async function findGradeLineItem(
  launchContext: LaunchContext,
): Promise<LineItem | undefined> {
  if (!launchContext.grading.isAvailable()) {
    throw new GradeLineItemError(
      `Assignment and Grade Services are unavailable for this launch. ${GRADE_SERVICE_SETTING_HINT}`,
      422,
    );
  }

  const claimedLineItemId = launchContext.idToken.services.assignmentAndGrades.lineItemId?.trim();
  if (claimedLineItemId) {
    const claimedLineItem = await launchContext.grading.getLineItemById(claimedLineItemId);
    if (!claimedLineItem.id) {
      throw new GradeLineItemError('The launch grade line item has no ID', 502);
    }
    return claimedLineItem;
  }

  const lineItems = (await getResourceLinkLineItems(launchContext)).filter((lineItem) =>
    Boolean(lineItem.id),
  );
  const canonicalLineItems = lineItems.filter(
    (lineItem) =>
      lineItem.resourceId === GRADE_LINE_ITEM_RESOURCE_ID || lineItem.tag === GRADE_LINE_ITEM_TAG,
  );

  if (canonicalLineItems.length === 1) return canonicalLineItems[0];
  if (canonicalLineItems.length > 1) {
    throw new GradeLineItemError(
      'Multiple OnTrack grade line items exist for this Moodle activity',
      409,
    );
  }

  return undefined;
}

export async function createGradeLineItem(launchContext: LaunchContext): Promise<LineItem> {
  const resourceLinkId = ltiResourceId(launchContext);
  if (!resourceLinkId) {
    throw new GradeLineItemError('LTI launch does not include a resource link ID', 400);
  }

  const createdLineItem = await launchContext.grading.createLineItem(
    {
      label: GRADE_LINE_ITEM_LABEL,
      scoreMaximum: 100,
      resourceId: GRADE_LINE_ITEM_RESOURCE_ID,
      resourceLinkId,
      tag: GRADE_LINE_ITEM_TAG,
    },
    { resourceLinkId: true },
  );
  if (!createdLineItem.id) {
    throw new GradeLineItemError('Moodle created a grade line item without returning its ID', 502);
  }
  return createdLineItem;
}
