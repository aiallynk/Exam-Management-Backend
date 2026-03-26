import Tenant from '../models/Tenant.js';
import { SUBSCRIPTION_STATUSES } from '../config/planLimits.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

let subscriptionExpiryTimer = null;

export const syncExpiredSubscriptions = async ({ now = new Date() } = {}) => {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();

  const result = await Tenant.updateMany(
    {
      'subscription.expiresAt': { $ne: null, $lte: safeNow },
      'subscription.status': {
        $nin: [SUBSCRIPTION_STATUSES.SUSPENDED, SUBSCRIPTION_STATUSES.CANCELLED],
      },
    },
    {
      $set: {
        'subscription.status': SUBSCRIPTION_STATUSES.EXPIRED,
        'subscription.updatedAt': safeNow,
      },
    }
  );

  return Number(result?.modifiedCount ?? result?.nModified ?? 0);
};

export const startSubscriptionExpiryScheduler = ({
  intervalMs = ONE_DAY_MS,
} = {}) => {
  if (subscriptionExpiryTimer) return;

  const safeIntervalMs = Math.max(Number(intervalMs) || ONE_DAY_MS, ONE_HOUR_MS);
  const run = async () => {
    try {
      const modified = await syncExpiredSubscriptions();
      if (modified > 0) {
        console.log(
          `[subscription-expiry] Marked ${modified} tenant subscription(s) as expired.`
        );
      }
    } catch (error) {
      console.error(
        '[subscription-expiry] Failed to sync tenant subscription statuses:',
        error?.message || error
      );
    }
  };

  // Run once on startup, then continue on schedule.
  run();
  subscriptionExpiryTimer = setInterval(run, safeIntervalMs);
  if (typeof subscriptionExpiryTimer.unref === 'function') {
    subscriptionExpiryTimer.unref();
  }
};

export const stopSubscriptionExpiryScheduler = () => {
  if (!subscriptionExpiryTimer) return;
  clearInterval(subscriptionExpiryTimer);
  subscriptionExpiryTimer = null;
};
