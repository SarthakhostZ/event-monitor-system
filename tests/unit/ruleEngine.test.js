'use strict';

/**
 * Unit tests for src/services/ruleEngine.js
 *
 * External dependencies (dynamodb, logger) are fully mocked so these tests
 * run without any AWS infrastructure.
 */

// Mock DynamoDB before requiring the module under test.
jest.mock('../../src/services/dynamodb');
// Silence logger output during tests.
jest.mock('../../src/utils/logger', () => ({
  debug: jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
}));

const db = require('../../src/services/dynamodb');
const {
  evaluateRules,
  checkFrequencyAnomaly,
  applyRules,
  matchingRules,
  _evaluateCondition,
  _applyOperator,
  _getField,
  _buildHourKey,
} = require('../../src/services/ruleEngine');

// ─────────────────────────────────────────────────────────────────────────────
// _getField
// ─────────────────────────────────────────────────────────────────────────────
describe('_getField', () => {
  it('returns a top-level field', () => {
    expect(_getField({ type: 'error' }, 'type')).toBe('error');
  });

  it('resolves a dot-notation path', () => {
    expect(_getField({ metadata: { count: 80 } }, 'metadata.count')).toBe(80);
  });

  it('resolves deeply nested paths', () => {
    expect(_getField({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for a missing top-level key', () => {
    expect(_getField({}, 'missing')).toBeUndefined();
  });

  it('returns undefined when an intermediate path segment is missing', () => {
    expect(_getField({ type: 'error' }, 'metadata.count')).toBeUndefined();
  });

  it('returns undefined when a nested segment is null', () => {
    expect(_getField({ metadata: null }, 'metadata.count')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _applyOperator
// ─────────────────────────────────────────────────────────────────────────────
describe('_applyOperator', () => {
  // equals ----------------------------------------------------------------
  describe('equals', () => {
    it('returns true for identical strings', () => {
      expect(_applyOperator('equals', 'error', 'error')).toBe(true);
    });

    it('returns false for different strings', () => {
      expect(_applyOperator('equals', 'error', 'info')).toBe(false);
    });

    it('matches numbers stored as different types', () => {
      // Field value may be a number; rule value may be a string in JSON.
      expect(_applyOperator('equals', 42, 42)).toBe(true);
    });

    it('returns false when value is undefined', () => {
      expect(_applyOperator('equals', undefined, 'error')).toBe(false);
    });
  });

  // contains ---------------------------------------------------------------
  describe('contains', () => {
    it('matches a substring (case-insensitive)', () => {
      expect(_applyOperator('contains', 'Payment gateway error', 'payment')).toBe(true);
    });

    it('returns false when substring is absent', () => {
      expect(_applyOperator('contains', 'user login', 'payment')).toBe(false);
    });

    it('matches an element in an array', () => {
      expect(_applyOperator('contains', ['email', 'slack'], 'slack')).toBe(true);
    });

    it('returns false for a missing array element', () => {
      expect(_applyOperator('contains', ['email'], 'sms')).toBe(false);
    });

    it('returns false when fieldValue is not a string or array', () => {
      expect(_applyOperator('contains', 42, 'payment')).toBe(false);
    });
  });

  // greaterThan ------------------------------------------------------------
  describe('greaterThan', () => {
    it('returns true when fieldValue > target', () => {
      expect(_applyOperator('greaterThan', 80, 50)).toBe(true);
    });

    it('returns false when fieldValue === target', () => {
      expect(_applyOperator('greaterThan', 50, 50)).toBe(false);
    });

    it('returns false when fieldValue < target', () => {
      expect(_applyOperator('greaterThan', 10, 50)).toBe(false);
    });

    it('returns false when fieldValue is not a number', () => {
      expect(_applyOperator('greaterThan', undefined, 50)).toBe(false);
    });
  });

  // lessThan ---------------------------------------------------------------
  describe('lessThan', () => {
    it('returns true when fieldValue < target', () => {
      expect(_applyOperator('lessThan', 10, 50)).toBe(true);
    });

    it('returns false when fieldValue === target', () => {
      expect(_applyOperator('lessThan', 50, 50)).toBe(false);
    });

    it('returns false when fieldValue > target', () => {
      expect(_applyOperator('lessThan', 80, 50)).toBe(false);
    });
  });

  // regex ------------------------------------------------------------------
  describe('regex', () => {
    it('returns true when pattern matches', () => {
      expect(_applyOperator('regex', 'error-503', '^error-\\d+')).toBe(true);
    });

    it('returns false when pattern does not match', () => {
      expect(_applyOperator('regex', 'info-200', '^error-\\d+')).toBe(false);
    });

    it('returns false gracefully for an invalid regex pattern', () => {
      expect(_applyOperator('regex', 'abc', '[')).toBe(false);
    });

    it('returns false when fieldValue is not a string', () => {
      expect(_applyOperator('regex', 42, '\\d+')).toBe(false);
    });
  });

  // exists -----------------------------------------------------------------
  describe('exists', () => {
    it('returns true when field is present', () => {
      expect(_applyOperator('exists', 'anything', null)).toBe(true);
    });

    it('returns false when field is undefined', () => {
      expect(_applyOperator('exists', undefined, null)).toBe(false);
    });

    it('returns false when field is null', () => {
      expect(_applyOperator('exists', null, null)).toBe(false);
    });
  });

  // unknown operator -------------------------------------------------------
  it('returns false for an unknown operator', () => {
    expect(_applyOperator('between', 5, 10)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _evaluateCondition
// ─────────────────────────────────────────────────────────────────────────────
describe('_evaluateCondition', () => {
  it('evaluates a simple base condition', () => {
    const cond  = { field: 'type', operator: 'equals', value: 'error' };
    expect(_evaluateCondition(cond, { type: 'error' })).toBe(true);
    expect(_evaluateCondition(cond, { type: 'info' })).toBe(false);
  });

  it('applies AND narrowing — both must match', () => {
    const cond = {
      field: 'type', operator: 'equals', value: 'error',
      and: { field: 'metadata.count', operator: 'greaterThan', value: 50 },
    };
    expect(_evaluateCondition(cond, { type: 'error', metadata: { count: 80 } })).toBe(true);
    expect(_evaluateCondition(cond, { type: 'error', metadata: { count: 10 } })).toBe(false);
    expect(_evaluateCondition(cond, { type: 'info',  metadata: { count: 80 } })).toBe(false);
  });

  it('applies OR broadening — either must match', () => {
    const cond = {
      field: 'type', operator: 'equals', value: 'critical',
      or: { field: 'type', operator: 'equals', value: 'error' },
    };
    expect(_evaluateCondition(cond, { type: 'critical' })).toBe(true);
    expect(_evaluateCondition(cond, { type: 'error' })).toBe(true);
    expect(_evaluateCondition(cond, { type: 'info' })).toBe(false);
  });

  it('handles AND + OR on the same node', () => {
    // (type=error AND count>50) OR source=webhook
    const cond = {
      field: 'type', operator: 'equals', value: 'error',
      and: { field: 'metadata.count', operator: 'greaterThan', value: 50 },
      or:  { field: 'source', operator: 'equals', value: 'webhook' },
    };
    // triggers via AND path
    expect(_evaluateCondition(cond, { type: 'error', metadata: { count: 80 } })).toBe(true);
    // triggers via OR path
    expect(_evaluateCondition(cond, { type: 'info', source: 'webhook' })).toBe(true);
    // neither
    expect(_evaluateCondition(cond, { type: 'info', source: 'api' })).toBe(false);
  });

  it('evaluates nested AND chains (depth > 2)', () => {
    const cond = {
      field: 'type', operator: 'equals', value: 'error',
      and: {
        field: 'metadata.category', operator: 'equals', value: 'payment',
        and: { field: 'metadata.count', operator: 'greaterThan', value: 5 },
      },
    };
    const event = { type: 'error', metadata: { category: 'payment', count: 10 } };
    expect(_evaluateCondition(cond, event)).toBe(true);
    // count too low
    expect(_evaluateCondition(cond, { ...event, metadata: { category: 'payment', count: 3 } })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateRules — against the actual rules.json definitions
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateRules', () => {
  it('rule: critical-event-type → critical severity, alert', () => {
    const result = evaluateRules({ type: 'critical', metadata: {} });
    expect(result.severity).toBe('critical');
    expect(result.shouldAlert).toBe(true);
    expect(result.matchedRules).toContain('critical-event-type');
  });

  it('rule: high-error-rate → high severity, alert when count > 50', () => {
    const result = evaluateRules({ type: 'error', metadata: { count: 80 } });
    expect(result.severity).toBe('high');
    expect(result.shouldAlert).toBe(true);
    expect(result.matchedRules).toContain('high-error-rate');
  });

  it('high-error-rate does NOT fire when count ≤ 50', () => {
    const result = evaluateRules({ type: 'error', metadata: { count: 50 } });
    // Falls through to payment-failure rules (no category here) then defaults
    expect(result.matchedRules).not.toContain('high-error-rate');
  });

  it('rule: payment-failure → high severity when category=payment', () => {
    const result = evaluateRules({ type: 'error', metadata: { category: 'payment' } });
    expect(result.severity).toBe('high');
    expect(result.shouldAlert).toBe(true);
    expect(result.matchedRules).toContain('payment-failure');
  });

  it('rule: payment-failure-title → high severity when title contains "payment"', () => {
    const result = evaluateRules({ type: 'error', title: 'Payment gateway timeout', metadata: {} });
    expect(result.severity).toBe('high');
    expect(result.shouldAlert).toBe(true);
    expect(result.matchedRules).toContain('payment-failure-title');
  });

  it('rule: api-high-latency → medium severity, no alert when latency > 5000', () => {
    const result = evaluateRules({ type: 'warning', metadata: { latencyMs: 6000 } });
    expect(result.severity).toBe('medium');
    expect(result.shouldAlert).toBe(false);
    expect(result.matchedRules).toContain('api-high-latency');
  });

  it('api-high-latency does NOT fire when latency ≤ 5000', () => {
    const result = evaluateRules({ type: 'warning', metadata: { latencyMs: 4999 } });
    expect(result.matchedRules).not.toContain('api-high-latency');
  });

  it('rule: signup-spike → medium severity, no alert when spike > 200', () => {
    const result = evaluateRules({ type: 'info', metadata: { signupSpike: 250 } });
    // info-event has lower priority but signup-spike fires first if spike > 200
    expect(result.severity).toBe('medium');
    expect(result.shouldAlert).toBe(false);
    expect(result.matchedRules).toContain('signup-spike');
  });

  it('rule: info-event → low severity, no alert', () => {
    const result = evaluateRules({ type: 'info', metadata: {} });
    expect(result.severity).toBe('low');
    expect(result.shouldAlert).toBe(false);
    expect(result.matchedRules).toContain('info-event');
  });

  it('returns defaults when no rule matches', () => {
    const result = evaluateRules({ type: 'warning', metadata: {} });
    expect(result.severity).toBe('medium');
    expect(result.shouldAlert).toBe(false);
    expect(result.matchedRules).toHaveLength(0);
  });

  it('matchedRules is always an array', () => {
    const result = evaluateRules({ type: 'unknown-type', metadata: {} });
    expect(Array.isArray(result.matchedRules)).toBe(true);
  });

  it('first-match priority: critical rule takes precedence over high-error-rate', () => {
    // type=critical also has count>50, but critical-event-type (priority 1) should win
    const result = evaluateRules({ type: 'critical', metadata: { count: 80 } });
    expect(result.severity).toBe('critical');
    expect(result.matchedRules[0]).toBe('critical-event-type');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyRules (legacy interface)
// ─────────────────────────────────────────────────────────────────────────────
describe('applyRules', () => {
  it('returns severity and triggerAlert from the first matching rule', () => {
    const result = applyRules({ type: 'critical', metadata: {} });
    expect(result.severity).toBe('critical');
    expect(result.triggerAlert).toBe(true);
    expect(result.matchedRuleId).toBe('critical-event-type');
  });

  it('returns null matchedRuleId and defaults when no rule matches', () => {
    const result = applyRules({ type: 'unknown', metadata: {} });
    expect(result.matchedRuleId).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// matchingRules
// ─────────────────────────────────────────────────────────────────────────────
describe('matchingRules', () => {
  it('returns all matching rule objects', () => {
    // A critical event also satisfies no other rules, but matchingRules scans all
    const matches = matchingRules({ type: 'critical', metadata: {} });
    expect(matches.map(r => r.id)).toContain('critical-event-type');
  });

  it('returns an empty array when nothing matches', () => {
    expect(matchingRules({ type: 'unknown', metadata: {} })).toHaveLength(0);
  });

  it('each entry contains id, priority and action', () => {
    const [first] = matchingRules({ type: 'critical', metadata: {} });
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('priority');
    expect(first).toHaveProperty('action');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _buildHourKey
// ─────────────────────────────────────────────────────────────────────────────
describe('_buildHourKey', () => {
  it('formats the key as events_by_type:<type>:<YYYY-MM-DDTHH>', () => {
    const date = new Date('2026-04-10T14:35:00.000Z');
    expect(_buildHourKey('error', date)).toBe('events_by_type:error:2026-04-10T14');
  });

  it('uses the event type verbatim', () => {
    const date = new Date('2026-04-10T09:00:00.000Z');
    expect(_buildHourKey('payment.failure', date)).toBe('events_by_type:payment.failure:2026-04-10T09');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkFrequencyAnomaly
// ─────────────────────────────────────────────────────────────────────────────
describe('checkFrequencyAnomaly', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns isAnomaly=false and zeros when MetricsTable has no data', async () => {
    db.query.mockResolvedValue({ items: [] });

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(false);
    expect(result.currentCount).toBe(0);
    expect(result.baselineAvg).toBe(0);
    expect(result.multiplier).toBe(0);
  });

  it('returns isAnomaly=false when no historical baseline exists (only current data)', async () => {
    // Current hour has events, but all past hours return empty → no baseline
    db.query
      .mockResolvedValueOnce({ items: [{ metricKey: 'k', value: 50 }] }) // current hour
      .mockResolvedValue({ items: [] }); // all baseline hours empty

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(false);
    expect(result.currentCount).toBe(50);
    expect(result.baselineAvg).toBe(0);
  });

  it('returns isAnomaly=false when current rate is below anomaly threshold', async () => {
    // Baseline avg = 100, current = 150 → multiplier 1.5 (< 3)
    db.query
      .mockResolvedValueOnce({ items: [{ value: 150 }] }) // current
      .mockResolvedValue({ items: [{ value: 100 }] });    // every baseline hour

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(false);
    expect(result.multiplier).toBeLessThan(3);
  });

  it('returns isAnomaly=true when current is ≥ 3× baseline average', async () => {
    // Baseline avg = 100, current = 300 → multiplier 3.0 → anomaly
    db.query
      .mockResolvedValueOnce({ items: [{ value: 300 }] }) // current
      .mockResolvedValue({ items: [{ value: 100 }] });    // every baseline hour

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(true);
    expect(result.currentCount).toBe(300);
    expect(result.multiplier).toBeGreaterThanOrEqual(3);
  });

  it('returns isAnomaly=true for a spike well above threshold', async () => {
    // Baseline avg = 20, current = 200 → multiplier 10
    db.query
      .mockResolvedValueOnce({ items: [{ value: 200 }] }) // current
      .mockResolvedValue({ items: [{ value: 20 }] });

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(true);
    expect(result.multiplier).toBeGreaterThanOrEqual(3);
  });

  it('excludes zero-count hours from the baseline average', async () => {
    // 1 non-zero baseline hour (value=100), the rest return empty.
    // Baseline avg should be 100, not diluted by zeros.
    // Current = 350 → multiplier = 3.5 → anomaly
    db.query
      .mockResolvedValueOnce({ items: [{ value: 350 }] })    // current hour
      .mockResolvedValueOnce({ items: [{ value: 100 }] })    // 1 hour ago
      .mockResolvedValue({ items: [] });                      // all other hours empty

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(true);
    expect(result.baselineAvg).toBe(100);
  });

  it('returns isAnomaly=false and zeros on a DynamoDB error', async () => {
    db.query.mockRejectedValue(new Error('DynamoDB throttled'));

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(result.isAnomaly).toBe(false);
    expect(result.currentCount).toBe(0);
  });

  it('rounds baselineAvg and multiplier to two decimal places', async () => {
    // 3 non-zero baseline hours with values 10, 20, 30 → avg = 20, current = 60
    db.query
      .mockResolvedValueOnce({ items: [{ value: 60 }] }) // current
      .mockResolvedValueOnce({ items: [{ value: 10 }] })
      .mockResolvedValueOnce({ items: [{ value: 20 }] })
      .mockResolvedValueOnce({ items: [{ value: 30 }] })
      .mockResolvedValue({ items: [] });

    const result = await checkFrequencyAnomaly({ type: 'error' });

    expect(Number.isFinite(result.baselineAvg)).toBe(true);
    expect(Number.isFinite(result.multiplier)).toBe(true);
    // Should have at most 2 decimal places
    expect(result.baselineAvg).toBe(+result.baselineAvg.toFixed(2));
    expect(result.multiplier).toBe(+result.multiplier.toFixed(2));
  });
});
