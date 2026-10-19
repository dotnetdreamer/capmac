/** The free-account capability policy: what a free Apple ID can sign, and what it can't. */
import { describe, expect, it } from 'vitest';
import {
  FREE_ACCOUNT_LIMITS, FREE_SUPPORTED_CAPABILITIES, freeCapabilityName, lostFeaturesSummary, planFreeCapabilities,
} from '../../packages/core/src/engine/wsl/free/free-capabilities.js';

describe('free Apple Account capabilities', () => {
  it('keeps the capabilities a free account supports and drops the rest', () => {
    const plan = planFreeCapabilities(['HEALTHKIT', 'PUSH_NOTIFICATIONS', 'APP_GROUPS', 'GAME_CENTER'], []);
    expect(plan.supported).toEqual(['APP_GROUPS', 'HEALTHKIT']);
    expect(plan.unsupported).toEqual(['GAME_CENTER', 'PUSH_NOTIFICATIONS']);
  });

  it('treats iCloud and Apple Pay as portal-only, never supported', () => {
    const plan = planFreeCapabilities([], ['iCloud', 'Apple Pay']);
    expect(plan.supported).toEqual([]);
    expect(plan.portalOnly).toEqual(['Apple Pay', 'iCloud']);
    expect(FREE_SUPPORTED_CAPABILITIES.has('PUSH_NOTIFICATIONS')).toBe(false);
  });

  it('summarizes what a free account will not sign, in plain words', () => {
    const plan = planFreeCapabilities(['PUSH_NOTIFICATIONS', 'APPLE_ID_AUTH'], ['iCloud']);
    const summary = lostFeaturesSummary(plan);
    expect(summary).toContain('Push Notifications');
    expect(summary).toContain('Sign in with Apple');
    expect(summary).toContain('iCloud');
  });

  it('has nothing to warn about when every capability is supported', () => {
    expect(lostFeaturesSummary(planFreeCapabilities(['HEALTHKIT', 'HOMEKIT'], []))).toBeUndefined();
    expect(lostFeaturesSummary(planFreeCapabilities([], []))).toBeUndefined();
  });

  it('names a capability nicely and states the standing limits', () => {
    expect(freeCapabilityName('PUSH_NOTIFICATIONS')).toBe('Push Notifications');
    expect(freeCapabilityName('SOMETHING_NEW')).toBe('something new');
    expect(FREE_ACCOUNT_LIMITS.some((limit) => /7-day|7 day|7 days/.test(limit))).toBe(true);
    expect(FREE_ACCOUNT_LIMITS.some((limit) => /3/.test(limit))).toBe(true);
  });
});
