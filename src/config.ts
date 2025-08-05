import dotenv from 'dotenv';

dotenv.config();

export const PORT = process.env.PORT || 3001;

// MongoDB Configuration
if (!process.env.DB_HOST) throw 'DB_HOST is not defined';
if (!process.env.DB_NAME) throw 'DB_NAME is not defined';
export const DB_HOST = process.env.DB_HOST;
export const DB_NAME = process.env.DB_NAME;
export const DB_USER: string | undefined = process.env.DB_USER;
export const DB_PASS: string | undefined = process.env.DB_PASS;

// LTI Configuration
if (!process.env.LTI_KEY) throw 'LTI_KEY is not defined';
if (!process.env.LTI_API_SECRET) throw 'LTI_API_SECRET is not defined';
export const LTI_KEY = process.env.LTI_KEY;
export const LTI_API_SECRET = process.env.LTI_API_SECRET;

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

export const PLATFORM_URL = process.env.PLATFORM_URL;
export const PLATFORM_NAME = process.env.PLATFORM_NAME;
export const PLATFORM_CLIENT_ID = process.env.PLATFORM_CLIENT_ID;
export const PLATFORM_AUTHENTICATION_ENDPOINT = process.env.PLATFORM_AUTHENTICATION_ENDPOINT;
export const PLATFORM_ACCESS_TOKEN_ENDPOINT = process.env.PLATFORM_ACCESS_TOKEN_ENDPOINT;
export const PLATFORM_AUTHCONFIG_METHOD = process.env.PLATFORM_AUTHCONFIG_METHOD;
export const PLATFORM_AUTHCONFIG_KEY = process.env.PLATFORM_AUTHCONFIG_KEY;
