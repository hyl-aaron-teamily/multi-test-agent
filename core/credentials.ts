// Model credential check shared by Android test + loop script.
// Same rule and message as fixtures/page.ts (week-1 web fixture, left unchanged on purpose);
// this copy has no vitest/playwright imports so plain Node scripts can use it.
const REQUIRED_MODEL_ENV = [
  'MIDSCENE_MODEL_BASE_URL',
  'MIDSCENE_MODEL_API_KEY',
  'MIDSCENE_MODEL_NAME',
  'MIDSCENE_MODEL_FAMILY',
] as const;

export class MissingModelCredentialsError extends Error {
  constructor(missing: string[]) {
    super(
      `[waiting for credentials] Midscene model config missing: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in a vision-model endpoint, then rerun.',
    );
    this.name = 'MissingModelCredentialsError';
  }
}

export function assertModelCredentials(): void {
  const missing = REQUIRED_MODEL_ENV.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) throw new MissingModelCredentialsError(missing);
}
