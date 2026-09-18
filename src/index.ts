import jwt from 'jsonwebtoken';
import { HttpError, IdTokenValidationMethod } from 'ltijs';
import mongoose from 'mongoose';
import { Config } from './config';
import { sendError } from './errors';
import { isStaffLaunch, ltiContextId, stringArrayClaim, stringClaim } from './lti-claims';
import { lti, ltiHttpHandler } from './lti-provider';
import { LTI_SESSION_COOKIE, ltiSessionCookieOptions } from './lti-session';
import { AppHandoffRouter } from './routes/app-handoff.route';
import { EnrolmentRouter } from './routes/enrolment.route';
import { GradeRouter } from './routes/grade.route';
import { InternalSyncRoute } from './routes/internal-sync.route';
import { MemberRoute } from './routes/member.route';
import { UnitLinkRouter } from './routes/unit-link.route';
import UnitLink from './schema/unitLink.model';
import { refreshLinkFromLaunch } from './services/lms-link.service';

interface AuthResponse {
  username: string;
  auth_token: string;
}

class RailsAuthenticationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly railsStatus: number | null,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = 'RailsAuthenticationError';
  }
}

function parseResponseBody(body: string): unknown {
  if (!body) return null;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function railsErrorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body) return body;
  if (!body || typeof body !== 'object') return fallback;

  for (const key of ['error', 'message']) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const nestedMessage = (value as Record<string, unknown>).message;
      if (typeof nestedMessage === 'string' && nestedMessage) return nestedMessage;
    }
  }

  return fallback;
}

// When receiving successful LTI launch redirects to app
lti.onResourceLink(async (launchContext, _request, response) => {
  const context = launchContext.idToken.launch.context;
  const contextLabel = stringClaim(context, 'label');
  const contextTitle = stringClaim(context, 'title');
  if (contextLabel && contextTitle) {
    console.log(`Context is ${contextLabel} - ${contextTitle}`);
    console.log(stringArrayClaim(context, 'type'));
  }

  try {
    const contextId = ltiContextId(launchContext);
    const link = contextId ? await UnitLink.findOne({ contextId }) : null;
    if (link) {
      // Keep the stored service details current; only staff launches pay for the plugin probe.
      await refreshLinkFromLaunch(link, launchContext, {
        probeCourseData: isStaffLaunch(launchContext.idToken.user.roles),
      });
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'lms_link_refresh_failure',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  let members;
  try {
    members = await launchContext.namesAndRoles.getMembers();
  } catch (error) {
    return void sendError(
      response,
      "Failed to get member information. Ensure 'IMS LTI Names and Role Provisioning' is enabled (not set to 'Do not use this service') and our public Keyset URL is accessible from your platform.",
      error instanceof HttpError && error.status ? error.status : 502,
    );
  }

  const member = members.members.find(
    (candidate) => candidate.userId === launchContext.idToken.user.id,
  );
  if (!member) {
    return void sendError(response, 'Could not retrieve member information', 400);
  }

  const newToken = {
    member,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30, // 30 seconds
    jti: crypto.randomUUID(),
  };
  const signedToken = jwt.sign(newToken, Config.LTI_SHARED_API_SECRET);

  // Create user and generate one-time auth token for the user to sign in with.
  const authUrl = `${Config.API_HOST}/api/auth/lti`;
  console.info(JSON.stringify({ event: 'rails_authentication_request', url: authUrl }));

  try {
    const railsResponse = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ltik: signedToken,
      }),
    });
    const responseBody = parseResponseBody(await railsResponse.text());
    if (!railsResponse.ok) {
      throw new RailsAuthenticationError(
        railsErrorMessage(
          responseBody,
          `Rails authentication failed with ${railsResponse.status} ${railsResponse.statusText}`,
        ),
        railsResponse.status,
        railsResponse.status,
        responseBody,
      );
    }

    const auth = responseBody as Partial<AuthResponse> | null;
    if (!auth || typeof auth !== 'object' || !auth.auth_token || !auth.username) {
      throw new RailsAuthenticationError(
        'Rails authentication response did not include user credentials',
        502,
        railsResponse.status,
        responseBody,
      );
    }

    console.info(
      JSON.stringify({
        event: 'rails_authentication_response',
        url: authUrl,
        status: railsResponse.status,
      }),
    );

    const sessionUrl = new URL('/lti/api/session', Config.APP_HOST);
    sessionUrl.searchParams.set('authToken', auth.auth_token);
    sessionUrl.searchParams.set('username', auth.username);
    launchContext.redirect(response, sessionUrl.toString());
  } catch (error) {
    const authenticationError =
      error instanceof RailsAuthenticationError
        ? error
        : new RailsAuthenticationError(
            error instanceof Error ? error.message : String(error),
            502,
            null,
            null,
          );

    console.error(
      JSON.stringify({
        event: 'rails_authentication_failure',
        url: authUrl,
        status: authenticationError.status,
        railsStatus: authenticationError.railsStatus,
        responseBody: authenticationError.responseBody,
        error: authenticationError.message,
      }),
    );

    return void sendError(response, authenticationError.message, authenticationError.status);
  }
});

ltiHttpHandler.app.get('/lti/api/session', async (req, res) => {
  const ltik = req.query.ltik;
  const authToken = req.query.authToken;
  const username = req.query.username;

  if (typeof ltik !== 'string' || typeof authToken !== 'string' || typeof username !== 'string') {
    return sendError(res, 'Invalid LTI session handoff', 400);
  }

  try {
    await lti.getLaunchContext(ltik);
  } catch {
    return sendError(res, 'Invalid or expired LTI session', 401);
  }

  res.cookie(LTI_SESSION_COOKIE, ltik, ltiSessionCookieOptions);

  const signInUrl = new URL('/sign_in', Config.APP_HOST);
  signInUrl.searchParams.set('authToken', authToken);
  signInUrl.searchParams.set('username', username);
  signInUrl.searchParams.set('isLtiLogin', 'true');
  return res.redirect(signInUrl.toString());
});

const setup = async () => {
  console.log(
    `Running LTI Server on port ${Config.PORT} in ${Config.IS_PRODUCTION ? 'Production' : 'Development'} mode`,
  );
  console.log(`LTI API host is ${Config.API_HOST}`);
  console.log(`LTI public application host is ${Config.APP_HOST}`);
  console.log(`Connecting to ${Config.DB_HOST}, ${Config.DB_NAME}.`);
  try {
    await mongoose.connect(
      `mongodb://${Config.DB_HOST}/${Config.DB_NAME}?authSource=admin`,
      Config.DB_USER && Config.DB_PASS ? { user: Config.DB_USER, pass: Config.DB_PASS } : undefined,
    );
    console.log('MondoDB connected');
  } catch (error) {
    console.error(`MongoDB Connection Failed: ${error}`);
  }

  await lti.listen();

  const existingPlatform = await lti.platformManager.getPlatformByUrlAndClientId(
    Config.PLATFORM_URL,
    Config.PLATFORM_CLIENT_ID,
  );
  if (!existingPlatform) {
    const validationMethods: Record<string, IdTokenValidationMethod> = {
      RSA_KEY: IdTokenValidationMethod.RsaKey,
      JWK_KEY: IdTokenValidationMethod.JwkKey,
      JWK_SET: IdTokenValidationMethod.JwkSet,
    };
    const validationMethod = validationMethods[Config.PLATFORM_AUTHCONFIG_METHOD];
    if (!validationMethod) {
      throw new Error(
        `Unsupported PLATFORM_AUTHCONFIG_METHOD: ${Config.PLATFORM_AUTHCONFIG_METHOD}`,
      );
    }

    await lti.platformManager.registerPlatform({
      url: Config.PLATFORM_URL,
      name: Config.PLATFORM_NAME,
      clientId: Config.PLATFORM_CLIENT_ID,
      authenticationEndpoint: Config.PLATFORM_AUTHENTICATION_ENDPOINT,
      accessTokenEndpoint: Config.PLATFORM_ACCESS_TOKEN_ENDPOINT,
      idTokenValidation: {
        method: validationMethod,
        key: Config.PLATFORM_AUTHCONFIG_KEY,
      },
    });
  }
};

ltiHttpHandler.app.use('/lti/api', GradeRouter);
ltiHttpHandler.app.use('/lti/api', EnrolmentRouter);
ltiHttpHandler.app.use('/lti/api', UnitLinkRouter);
ltiHttpHandler.app.use('/lti/api', MemberRoute);
ltiHttpHandler.app.use('/lti/api', AppHandoffRouter);
ltiHttpHandler.app.use('/lti/api', InternalSyncRoute);

setup();
