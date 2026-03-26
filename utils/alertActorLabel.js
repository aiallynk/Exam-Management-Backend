const toNonEmptyString = (value) => {
  const normalized = String(value ?? '').trim();
  return normalized || '';
};

const toSafeObject = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const normalized = toNonEmptyString(value);
    if (normalized) return normalized;
  }
  return '';
};

export const resolveAlertUserName = (source = {}) => {
  const root = toSafeObject(source);
  const user = toSafeObject(root.user);

  return firstNonEmpty(
    root.fullName,
    root.name,
    root.userName,
    root.user_name,
    root.actor_user_name,
    user.fullName,
    user.name
  );
};

export const resolveAlertUserEmail = (source = {}) => {
  const root = toSafeObject(source);
  const user = toSafeObject(root.user);

  return firstNonEmpty(
    root.email,
    root.userEmail,
    root.user_email,
    root.actor_user_email,
    user.email
  );
};

export const formatAlertUserLabel = ({ name = '', email = '', fallback = '' } = {}) => {
  const normalizedName = toNonEmptyString(name);
  const normalizedEmail = toNonEmptyString(email);

  if (normalizedName && normalizedEmail) {
    if (normalizedName.toLowerCase() === normalizedEmail.toLowerCase()) {
      return normalizedEmail;
    }
    return `${normalizedName} (${normalizedEmail})`;
  }
  if (normalizedName) return normalizedName;
  if (normalizedEmail) return normalizedEmail;
  return toNonEmptyString(fallback);
};

export const buildAlertUserLabel = (source = {}, fallback = '') =>
  formatAlertUserLabel({
    name: resolveAlertUserName(source),
    email: resolveAlertUserEmail(source),
    fallback,
  });
