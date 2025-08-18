# OnTrack LTI Integration

## Description

This API acts as a bridge between OnTrack’s Ruby API and LTI.js. The Angular frontend communicates with:

• LTI.js API → http://localhost:4200/lti

• Ruby API → http://localhost:4200/api

LTI.js simplifies integration with LMS platforms, while the Ruby API manages most permissions and institution-specific logic. Together, they enable enrolment syncing, and grade exchange between OnTrack and an LMS.

## Permissions & Roles

Most permissions are handled by OnTrack's Ruby API. This means you will already need to have the Convenor role of a unit to be able to link the unit to a [Context](https://www.imsglobal.org/spec/lti/v1p3#contexts-and-resources), and run actions such as syncing enrolments, and importing portfolio grades. These permissions can be modified in the Institution Settings within the Ruby API.

#### Convenors:

- Can link LMS course contexts to OnTrack units.
- Can sync LMS enrolments into OnTrack.
- Can import OnTrack portfolio grades.

#### Automatic Account Handling:

- Any user launching the external tool gets an OnTrack account automatically, using the email and account details used in the LMS.
- If a unit is linked, they are auto-enrolled.

```yaml
Tool Name: OnTrack
Tool URL: http://localhost:4200/lti/
LTI Version: LTI 1.3
Public Key Type: Keyset URL

Public keyset URL: http://localhost:4200/lti/keys

# If moodle is running in a Docker container, you need to specify `host.docker.internal` so that it can make a fetch request to moodles public keys
Public keyset URL: http://host.docker.internal/lti/keys

# These routes are loaded in the browser, and can reach localhost

Initiate login URL: http://localhost:4200/lti/login
Redirection URI(s): http://localhost:4200/lti/
```

### Configuring the Lti API Environment variables

```yaml
HOST: http://localhost:4200

PORT: 3002
LTI_KEY: your-secret-lti-key

PLATFORM_URL: http://localhost/moodle
PLATFORM_NAME: Moodle Test Environment
# Once you have added OnTrack as an external tool, you can retrieve its client ID and add it here
PLATFORM_CLIENT_ID: your-client-id
PLATFORM_AUTHENTICATION_ENDPOINT: http://localhost/moodle/mod/lti/auth.php
PLATFORM_ACCESS_TOKEN_ENDPOINT: http://localhost/moodle/mod/lti/token.php
PLATFORM_AUTHCONFIG_METHOD: JWK_SET
PLATFORM_AUTHCONFIG_KEY: http://localhost/moodle/mod/lti/certs.php

# MongoDB details
DB_HOST: localhost:27017
DB_NAME: ltidb
DB_USER:
DB_PASS:

# Secret key used by the Ruby API to decode our custom LTI tokens.
# Must match the value configured in the Ruby API.
LTI_SHARED_API_SECRET: your-secret-shared-api-secret
```
