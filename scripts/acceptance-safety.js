/**
 * Guard the destructive acceptance walkthrough and its server reset.
 * These checks run before any database connection or workspace cleanup.
 */
function parseDatabase(value, label) {
  if (!value) throw new Error(`${label} must be set explicitly for acceptance`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a PostgreSQL URL`); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error(`${label} must be a PostgreSQL URL`);
  }
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name || name.includes('/')) throw new Error(`${label} must name one database`);
  return { url, name, identity: `${url.hostname.toLowerCase()}:${url.port || '5432'}/${name.toLowerCase()}` };
}

export function assertAcceptanceDatabase(env = process.env) {
  const test = parseDatabase(env.ACCEPT_DATABASE_URL, 'ACCEPT_DATABASE_URL');
  if (!/(?:^test(?:_|$)|(?:_|-)test(?:_|$)|(?:_|-)acceptance(?:_|$))/i.test(test.name)) {
    throw new Error('ACCEPT_DATABASE_URL must name a dedicated test or acceptance database');
  }
  const production = env.ACCEPT_PRODUCTION_DATABASE_URL || env.DATABASE_URL;
  if (production && parseDatabase(production, 'DATABASE_URL').identity === test.identity) {
    throw new Error('ACCEPT_DATABASE_URL must differ from DATABASE_URL (host and database)');
  }
  return env.ACCEPT_DATABASE_URL;
}

export function assertAcceptanceResetEnvironment(env = process.env) {
  if (env.ACCEPTANCE_RESET_ALLOWED !== '1') {
    throw new Error('RESET_STORE_ON_START requires the acceptance reset guard');
  }
  const database = assertAcceptanceDatabase({
    ...env,
    DATABASE_URL: env.ACCEPT_PRODUCTION_DATABASE_URL || '',
  });
  if (parseDatabase(env.DATABASE_URL, 'DATABASE_URL').identity !==
      parseDatabase(database, 'ACCEPT_DATABASE_URL').identity) {
    throw new Error('Reset database must match ACCEPT_DATABASE_URL');
  }
}
