import dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.PORT || 3001;
if (!process.env.HOST) throw 'HOST is not defined';
const HOST = process.env.HOST;

// MongoDB Configuration
if (!process.env.DB_HOST) throw 'DB_HOST is not defined';
if (!process.env.DB_NAME) throw 'DB_NAME is not defined';
const DB_HOST = process.env.DB_HOST;
const DB_NAME = process.env.DB_NAME;
const DB_USER: string | undefined = process.env.DB_USER;
const DB_PASS: string | undefined = process.env.DB_PASS;

// LTI Configuration
if (!process.env.LTI_KEY) throw 'LTI_KEY is not defined';
if (!process.env.LTI_SHARED_API_SECRET) throw 'LTI_SHARED_API_SECRET is not defined';
const LTI_KEY = process.env.LTI_KEY;
const LTI_SHARED_API_SECRET = process.env.LTI_SHARED_API_SECRET;

const LTI_COOKIES_SECURE = Boolean(process.env.LTI_COOKIES_SECURE ?? false);
const LTI_COOKIES_SAMESITE = process.env.LTI_COOKIES_SAMESITE ?? '';

// Platform Configuration
if (!process.env.PLATFORM_URL) throw 'PLATFORM_URL is not defined';
if (!process.env.PLATFORM_NAME) throw 'PLATFORM_NAME is not defined';
if (!process.env.PLATFORM_CLIENT_ID) throw 'PLATFORM_CLIENT_ID is not defined';
if (!process.env.PLATFORM_AUTHENTICATION_ENDPOINT)
  throw 'PLATFORM_AUTHENTICATION_ENDPOINT is not defined';
if (!process.env.PLATFORM_ACCESS_TOKEN_ENDPOINT)
  throw 'PLATFORM_ACCESS_TOKEN_ENDPOINT is not defined';
if (!process.env.PLATFORM_AUTHCONFIG_METHOD) throw 'PLATFORM_AUTHCONFIG_METHOD is not defined';
if (!process.env.PLATFORM_AUTHCONFIG_KEY) throw 'PLATFORM_AUTHCONFIG_KEY is not defined';

const PLATFORM_URL = process.env.PLATFORM_URL;
const PLATFORM_NAME = process.env.PLATFORM_NAME;
const PLATFORM_CLIENT_ID = process.env.PLATFORM_CLIENT_ID;
const PLATFORM_AUTHENTICATION_ENDPOINT = process.env.PLATFORM_AUTHENTICATION_ENDPOINT;
const PLATFORM_ACCESS_TOKEN_ENDPOINT = process.env.PLATFORM_ACCESS_TOKEN_ENDPOINT;
const PLATFORM_AUTHCONFIG_METHOD = process.env.PLATFORM_AUTHCONFIG_METHOD;
const PLATFORM_AUTHCONFIG_KEY = process.env.PLATFORM_AUTHCONFIG_KEY;

export const Config = {
  PORT,
  HOST,

  DB_HOST,
  DB_NAME,
  DB_USER,
  DB_PASS,

  LTI_KEY,
  LTI_SHARED_API_SECRET,
  LTI_COOKIES_SECURE,
  LTI_COOKIES_SAMESITE,

  PLATFORM_URL,
  PLATFORM_NAME,
  PLATFORM_CLIENT_ID,
  PLATFORM_AUTHENTICATION_ENDPOINT,
  PLATFORM_ACCESS_TOKEN_ENDPOINT,
  PLATFORM_AUTHCONFIG_METHOD,
  PLATFORM_AUTHCONFIG_KEY,

  IS_PRODUCTION: process.env.NODE_ENV === 'production',
};
