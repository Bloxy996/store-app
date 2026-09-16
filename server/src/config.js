import 'dotenv/config';

// Same "drive.file only isn't enough for an existing vault" reasoning as
// src/lib/vaultConfig.js on the frontend — kept in sync deliberately.
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} — see server/.env.example`);
  }
  return value;
}

const config = {
  port: Number(process.env.PORT || 8787),
  googleClientId: required('GOOGLE_CLIENT_ID'),
  googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
  googleRedirectUri: required('GOOGLE_REDIRECT_URI'),
  sessionSecret: required('SESSION_SECRET'),
  // First entry is the default post-login redirect target; the full list
  // is what CORS treats as allowed origins.
  frontendUrls: required('FRONTEND_URL')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  driveScope: DRIVE_SCOPE
};

export { config };
