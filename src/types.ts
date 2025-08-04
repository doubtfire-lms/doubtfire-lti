export interface LtiLaunchPayload {
  iss?: string | undefined;
  user?: string | undefined;
  userInfo?:
    | {
        given_name?: string;
        family_name?: string;
        name?: string;
        email?: string;
      }
    | undefined;
  platformInfo?:
    | {
        product_family_code?: string;
        version?: string;
        guid?: string;
        name?: string;
        description?: string;
      }
    | undefined;
  clientId?: string | undefined;
  platformId?: string | undefined;
  deploymentId?: string | undefined;
  createdAt?: string | undefined;
  platformContext?:
    | {
        contextId?: string;
        user?: string;
        roles?: string[] | undefined;
        path?: string;
        targetLinkUri?: string;
        context?:
          | {
              id?: string;
              label?: string;
              title?: string;
              type?: string[];
            }
          | undefined;
        resource?: {
          title?: string;
          description?: string;
          id?: string;
        };
        custom?: {
          context_memberships_url?: string;
          system_setting_url?: string;
          context_setting_url?: string;
          link_setting_url?: string;
        };
        launchPresentation?: {
          locale?: string;
          document_target?: string;
          return_url?: string;
        };
        messageType?: string;
        version?: string;
        lis?: {
          person_sourcedid?: string;
          course_section_sourcedid?: string;
        };
        endpoint?:
          | {
              scope?: string[];
              lineitems?: string;
              lineitem?: string;
            }
          | undefined;
        namesRoles?: {
          context_memberships_url?: string;
          service_versions?: string[];
        };
        createdAt?: string;
      }
    | undefined;
  iat?: number | undefined;
}
