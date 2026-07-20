import dotenv from 'dotenv';

dotenv.config();

const config = {
  PORT: Number(process.env.PORT) || 3000,
  API_KEY: process.env.API_KEY || '',
  STORAGE_PATH: process.env.STORAGE_PATH || './src/storage',
  RETENTION_DAYS: Number(process.env.RETENTION_DAYS) || 7,
  MAX_FILE_SIZE_MB: Number(process.env.MAX_FILE_SIZE_MB) || 10,
  LENS_COOKIE: process.env.LENS_COOKIE || '',
  LENS_PROXY_URL: process.env.LENS_PROXY_URL || '',
};

export default config;
