export const SECTION_NAVIGATION_RULES = Object.freeze({
  FREE: 'FREE',
  NO_FREE: 'NO_FREE',
  LINEAR: 'LINEAR',
  ADMIN_CONFIGURED: 'ADMIN_CONFIGURED',
});

export const SECTION_TIMER_CONFIG = Object.freeze({
  WARNING_THRESHOLD_SECONDS: 60,
  HEARTBEAT_INTERVAL_SECONDS: 30,
  MIN_SECTION_DURATION_MINUTES: 1,
});

export const isNoFreeNavigationRule = (rule) => {
  const normalized = String(rule || '').toUpperCase();
  return (
    normalized === SECTION_NAVIGATION_RULES.NO_FREE ||
    normalized === SECTION_NAVIGATION_RULES.LINEAR
  );
};

export const normalizeNavigationRule = (rule) =>
  isNoFreeNavigationRule(rule)
    ? SECTION_NAVIGATION_RULES.NO_FREE
    : SECTION_NAVIGATION_RULES.FREE;
