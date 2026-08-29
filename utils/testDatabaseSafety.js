const DISPOSABLE_DATABASE_PREFIX = 'xamigo_phase5_e2e';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const stripIpv6Brackets = (value) => value.replace(/^\[/, '').replace(/\]$/, '');

export const parseMongoTarget = (uri) => {
  const normalized = String(uri || '').trim();
  if (!normalized.startsWith('mongodb://')) {
    throw new Error('Disposable E2E MongoDB must use a local mongodb:// URI. Atlas/SRV targets are refused.');
  }

  const withoutScheme = normalized.slice('mongodb://'.length);
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex < 0) {
    throw new Error('Disposable E2E MongoDB URI must include an explicit database name.');
  }

  const authority = withoutScheme.slice(0, slashIndex).split('@').at(-1);
  const databaseName = decodeURIComponent(
    withoutScheme.slice(slashIndex + 1).split('?')[0].split('/')[0] || '',
  );
  const hosts = authority.split(',').map((entry) => {
    const hostPort = entry.trim();
    if (hostPort.startsWith('[')) return stripIpv6Brackets(hostPort.split(']')[0] + ']');
    return hostPort.split(':')[0];
  });

  return { uri: normalized, databaseName, hosts };
};

export const assertDisposableTestDatabase = ({
  nodeEnv = process.env.NODE_ENV,
  uri = process.env.TEST_MONGODB_URI,
} = {}) => {
  if (nodeEnv !== 'test') {
    throw new Error('Destructive E2E setup is refused unless NODE_ENV=test.');
  }

  const target = parseMongoTarget(uri);
  if (!target.databaseName.startsWith(DISPOSABLE_DATABASE_PREFIX)) {
    throw new Error(
      `Disposable E2E database name must start with "${DISPOSABLE_DATABASE_PREFIX}"; received "${target.databaseName || '(missing)'}".`,
    );
  }
  if (!target.hosts.length || target.hosts.some((host) => !LOCAL_HOSTS.has(host))) {
    throw new Error('Destructive E2E setup is restricted to localhost MongoDB hosts.');
  }

  return target;
};

export { DISPOSABLE_DATABASE_PREFIX };
