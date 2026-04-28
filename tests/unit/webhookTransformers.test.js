'use strict';

/**
 * Unit tests for src/services/webhookTransformers.js
 * All functions are pure — no mocks required.
 */

const {
  SUPPORTED_SOURCES,
  transform,
  deriveIdempotencyKey,
  extractSourceTimestamp,
} = require('../../src/services/webhookTransformers');

// ─── SUPPORTED_SOURCES ────────────────────────────────────────────────────────

describe('SUPPORTED_SOURCES', () => {
  it('includes github, stripe, datadog, generic', () => {
    expect(SUPPORTED_SOURCES).toEqual(expect.arrayContaining(['github', 'stripe', 'datadog', 'generic']));
  });
});

// ─── transform — error cases ─────────────────────────────────────────────────

describe('transform — unsupported source', () => {
  it('throws with UNSUPPORTED_SOURCE code', () => {
    expect(() => transform('unknown', {}, {})).toThrow('Unsupported webhook source');
  });
});

// ─── GitHub transformer ───────────────────────────────────────────────────────

describe('transform — github', () => {
  const repo = { full_name: 'org/repo', name: 'repo' };

  it('handles ping events', () => {
    const result = transform('github', { hook_id: 1, zen: 'do more', repository: repo }, { 'x-github-event': 'ping' });
    expect(result.source).toBe('webhook');
    expect(result.type).toBe('info');
    expect(result.severity).toBe('low');
    expect(result.title).toContain('org/repo');
  });

  it('handles push to main branch with high severity', () => {
    const payload = {
      ref: 'refs/heads/main',
      commits: [{ id: 'abc1234', message: 'fix bug', author: { name: 'dev' } }],
      repository: repo,
      pusher: { name: 'dev' },
      compare: 'http://compare',
    };
    const result = transform('github', payload, { 'x-github-event': 'push' });
    expect(result.severity).toBe('medium');
    expect(result.title).toContain('main');
    expect(result.metadata.isMainBranch).toBe(true);
  });

  it('handles push to feature branch with low severity', () => {
    const payload = {
      ref: 'refs/heads/feature/my-feature',
      commits: [],
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'push' });
    expect(result.severity).toBe('low');
    expect(result.metadata.isMainBranch).toBe(false);
  });

  it('handles pull_request opened', () => {
    const payload = {
      action: 'opened',
      pull_request: { number: 42, title: 'My PR', html_url: 'http://pr', user: { login: 'dev' }, additions: 5, deletions: 2, changed_files: 1 },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'pull_request' });
    expect(result.title).toContain('PR #42');
    expect(result.title).toContain('opened');
  });

  it('handles pull_request merged', () => {
    const payload = {
      action: 'closed',
      pull_request: { number: 42, title: 'My PR', html_url: 'http://pr', user: { login: 'dev' }, merged: true },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'pull_request' });
    expect(result.title).toContain('merged');
  });

  it('handles issues opened without critical label', () => {
    const payload = {
      action: 'opened',
      issue: { number: 10, title: 'Bug', html_url: 'http://issue', user: { login: 'user' }, labels: [], body: 'details' },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'issues' });
    expect(result.type).toBe('warning');
    expect(result.severity).toBe('low');
  });

  it('handles issues opened with critical label → high severity', () => {
    const payload = {
      action: 'opened',
      issue: { number: 11, title: 'Critical Bug', labels: [{ name: 'critical' }], html_url: 'http://issue', user: { login: 'dev' }, body: '' },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'issues' });
    expect(result.severity).toBe('high');
  });

  it('handles workflow_run failure', () => {
    const payload = {
      workflow_run: { name: 'CI', conclusion: 'failure', html_url: 'http://wf', head_branch: 'main', head_sha: 'abcdef1234567890', id: 1, run_number: 5 },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'workflow_run' });
    expect(result.type).toBe('error');
    expect(result.severity).toBe('high');
  });

  it('handles workflow_run success', () => {
    const payload = {
      workflow_run: { name: 'CI', conclusion: 'success', html_url: 'http://wf', head_branch: 'main', head_sha: 'abc1234', id: 1, run_number: 5 },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'workflow_run' });
    expect(result.type).toBe('info');
    expect(result.severity).toBe('low');
  });

  it('handles deployment_status failure', () => {
    const payload = {
      deployment_status: { state: 'failure', target_url: 'http://deploy', description: 'Failed' },
      deployment: { environment: 'production', sha: 'abc1234', creator: { login: 'dev' } },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'deployment_status' });
    expect(result.type).toBe('error');
    expect(result.severity).toBe('high');
  });

  it('handles deployment_status success', () => {
    const payload = {
      deployment_status: { state: 'success', target_url: 'http://deploy', description: 'OK' },
      deployment: { environment: 'staging', sha: 'abc1234' },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'deployment_status' });
    expect(result.type).toBe('info');
  });

  it('handles release published', () => {
    const payload = {
      action: 'published',
      release: { tag_name: 'v1.0.0', html_url: 'http://release', author: { login: 'dev' }, body: 'Release notes', prerelease: false },
      repository: repo,
    };
    const result = transform('github', payload, { 'x-github-event': 'release' });
    expect(result.title).toContain('v1.0.0');
  });

  it('handles create event (branch)', () => {
    const payload = { ref: 'feature/new', ref_type: 'branch', sender: { login: 'dev' }, repository: repo };
    const result = transform('github', payload, { 'x-github-event': 'create' });
    expect(result.title).toContain('created');
  });

  it('handles delete event (tag)', () => {
    const payload = { ref: 'v0.9', ref_type: 'tag', sender: { login: 'dev' }, repository: repo };
    const result = transform('github', payload, { 'x-github-event': 'delete' });
    expect(result.title).toContain('deleted');
  });

  it('handles unknown github event type', () => {
    const result = transform('github', { repository: repo }, { 'x-github-event': 'fork' });
    expect(result.type).toBe('info');
    expect(result.severity).toBe('low');
  });

  it('uses X-GitHub-Event header (uppercase) as fallback', () => {
    const result = transform('github', { hook_id: 1, zen: 'z', repository: repo }, { 'X-GitHub-Event': 'ping' });
    expect(result.title).toContain('webhook connected');
  });
});

// ─── Stripe transformer ───────────────────────────────────────────────────────

describe('transform — stripe', () => {
  function stripePayload(type, obj = {}) {
    return { id: 'evt_1', type, livemode: false, data: { object: obj } };
  }

  it('handles payment_intent.payment_failed → error high', () => {
    const result = transform('stripe', stripePayload('payment_intent.payment_failed', {
      id: 'pi_1', amount: 5000, currency: 'usd', last_payment_error: { code: 'card_declined', message: 'Card declined' }, customer: 'cus_1',
    }), {});
    expect(result.type).toBe('error');
    expect(result.severity).toBe('high');
    expect(result.title).toContain('Payment failed');
  });

  it('handles payment_intent.succeeded → info low', () => {
    const result = transform('stripe', stripePayload('payment_intent.succeeded', {
      id: 'pi_1', amount: 5000, currency: 'usd', customer: 'cus_1',
    }), {});
    expect(result.type).toBe('info');
    expect(result.severity).toBe('low');
  });

  it('handles charge.failed → error medium', () => {
    const result = transform('stripe', stripePayload('charge.failed', {
      id: 'ch_1', amount: 1000, currency: 'eur', failure_code: 'insufficient_funds', failure_message: 'Not enough funds',
    }), {});
    expect(result.type).toBe('error');
    expect(result.severity).toBe('medium');
  });

  it('handles charge.dispute.created → warning high', () => {
    const result = transform('stripe', stripePayload('charge.dispute.created', {
      id: 'dp_1', amount: 2000, currency: 'usd', charge: 'ch_1', reason: 'fraudulent', status: 'warning_needs_response',
    }), {});
    expect(result.type).toBe('warning');
    expect(result.severity).toBe('high');
  });

  it('handles invoice.payment_failed attempt < 3 → high', () => {
    const result = transform('stripe', stripePayload('invoice.payment_failed', {
      id: 'in_1', amount_due: 3000, currency: 'usd', customer: 'cus_1', attempt_count: 1, next_payment_attempt: null,
    }), {});
    expect(result.severity).toBe('high');
  });

  it('handles invoice.payment_failed attempt >= 3 → critical', () => {
    const result = transform('stripe', stripePayload('invoice.payment_failed', {
      id: 'in_1', amount_due: 3000, currency: 'usd', customer: 'cus_1', attempt_count: 3, next_payment_attempt: null,
    }), {});
    expect(result.severity).toBe('critical');
  });

  it('handles customer.subscription.deleted → warning high', () => {
    const result = transform('stripe', stripePayload('customer.subscription.deleted', {
      id: 'sub_1', customer: 'cus_1', status: 'canceled', cancellation_details: { reason: 'cancellation_requested' },
    }), {});
    expect(result.type).toBe('warning');
    expect(result.severity).toBe('high');
  });

  it('handles radar.early_fraud_warning.created → critical', () => {
    const result = transform('stripe', stripePayload('radar.early_fraud_warning.created', {
      id: 'issfr_1', charge: 'ch_1', fraud_type: 'multiple_fraud_reports',
    }), {});
    expect(result.type).toBe('critical');
    expect(result.severity).toBe('critical');
  });

  it('handles unknown Stripe event type → info low', () => {
    const result = transform('stripe', stripePayload('customer.created'), {});
    expect(result.type).toBe('info');
    expect(result.severity).toBe('low');
  });

  it('uses [LIVE] tag for livemode events', () => {
    const payload = { id: 'evt_1', type: 'payment_intent.succeeded', livemode: true, data: { object: { id: 'pi_1', amount: 100, currency: 'usd' } } };
    const result = transform('stripe', payload, {});
    expect(result.title).toContain('[LIVE]');
  });
});

// ─── Datadog transformer ──────────────────────────────────────────────────────

describe('transform — datadog', () => {
  it('maps alert → error high', () => {
    const result = transform('datadog', {
      alert_status: 'alert', event_title: 'CPU high', event_message: 'CPU > 90%', host: 'web-01', monitor_id: 'm1',
    }, {});
    expect(result.type).toBe('error');
    expect(result.severity).toBe('high');
  });

  it('maps warning → warning medium', () => {
    const result = transform('datadog', {
      alert_status: 'warning', event_title: 'Memory usage', host: 'db-01',
    }, {});
    expect(result.type).toBe('warning');
    expect(result.severity).toBe('medium');
  });

  it('maps recovered → info low', () => {
    const result = transform('datadog', {
      alert_status: 'recovered', event_title: 'CPU normal', host: 'web-01',
    }, {});
    expect(result.type).toBe('info');
    expect(result.severity).toBe('low');
  });

  it('handles unknown alert_status with medium severity fallback', () => {
    const result = transform('datadog', {
      alert_status: 'unknown_state', event_title: 'Something happened',
    }, {});
    expect(result.severity).toBe('medium');
  });

  it('parses comma-separated tags string', () => {
    const result = transform('datadog', {
      alert_status: 'alert', event_title: 'Test', tags: 'env:prod,team:infra',
    }, {});
    expect(result.metadata.tags).toContain('env:prod');
  });

  it('handles tags as array', () => {
    const result = transform('datadog', {
      alert_status: 'ok', event_title: 'Test', tags: ['env:prod', 'team:infra'],
    }, {});
    expect(result.metadata.tags).toEqual(['env:prod', 'team:infra']);
  });

  it('uses no_data → warning medium', () => {
    const result = transform('datadog', { alert_status: 'no_data', event_title: 'Missing metric' }, {});
    expect(result.type).toBe('warning');
    expect(result.severity).toBe('medium');
  });
});

// ─── Generic transformer ──────────────────────────────────────────────────────

describe('transform — generic', () => {
  it('passes through valid type and severity', () => {
    const result = transform('generic', { type: 'error', severity: 'critical', title: 'Test', description: 'Details' }, {});
    expect(result.type).toBe('error');
    expect(result.severity).toBe('critical');
  });

  it('falls back to info/medium for invalid type/severity', () => {
    const result = transform('generic', { type: 'invalid', severity: 'extreme', title: 'Test' }, {});
    expect(result.type).toBe('info');
    expect(result.severity).toBe('medium');
  });

  it('uses payload.name as title fallback', () => {
    const result = transform('generic', { name: 'my-event', type: 'info', severity: 'low' }, {});
    expect(result.title).toContain('my-event');
  });

  it('uses x-source-name header hint', () => {
    const result = transform('generic', { type: 'info', severity: 'low' }, { 'x-source-name': 'my-app' });
    expect(result.title).toContain('my-app');
  });

  it('merges metadata, meta, and attributes', () => {
    const result = transform('generic', {
      type: 'info', severity: 'low', title: 'T',
      metadata: { a: 1 }, meta: { b: 2 }, attributes: { c: 3 },
    }, {});
    expect(result.metadata.a).toBe(1);
    expect(result.metadata.b).toBe(2);
    expect(result.metadata.c).toBe(3);
  });

  it('sets source to webhook', () => {
    const result = transform('generic', { type: 'info', severity: 'low', title: 'T' }, {});
    expect(result.source).toBe('webhook');
  });
});

// ─── deriveIdempotencyKey ────────────────────────────────────────────────────

describe('deriveIdempotencyKey', () => {
  it('uses x-github-delivery for github', () => {
    const key = deriveIdempotencyKey('github', {}, { 'x-github-delivery': 'abc-123' });
    expect(key).toBe('github:abc-123');
  });

  it('falls back to payload hash for github when no delivery header', () => {
    const key = deriveIdempotencyKey('github', { type: 'push' }, {});
    expect(key).toMatch(/^github:/);
  });

  it('uses payload.id for stripe', () => {
    const key = deriveIdempotencyKey('stripe', { id: 'evt_1' }, {});
    expect(key).toBe('stripe:evt_1');
  });

  it('uses alert_id for datadog', () => {
    const key = deriveIdempotencyKey('datadog', { alert_id: 'alert-99' }, {});
    expect(key).toBe('datadog:alert-99');
  });

  it('uses event_id for datadog when alert_id absent', () => {
    const key = deriveIdempotencyKey('datadog', { event_id: 'ev-42' }, {});
    expect(key).toBe('datadog:ev-42');
  });

  it('uses payload.id for generic', () => {
    const key = deriveIdempotencyKey('generic', { id: 'gen-1' }, {});
    expect(key).toBe('generic:gen-1');
  });

  it('falls back to hash for generic when no id', () => {
    const key = deriveIdempotencyKey('generic', { type: 'info' }, {});
    expect(key).toMatch(/^generic:/);
  });
});

// ─── extractSourceTimestamp ──────────────────────────────────────────────────

describe('extractSourceTimestamp', () => {
  it('returns stripe created timestamp directly', () => {
    const ts = extractSourceTimestamp('stripe', { created: 1700000000 }, {});
    expect(ts).toBe(1700000000);
  });

  it('returns null for stripe when created is missing', () => {
    const ts = extractSourceTimestamp('stripe', {}, {});
    expect(ts).toBeNull();
  });

  it('returns github pushed_at as epoch seconds', () => {
    const pushed = '2024-01-01T12:00:00Z';
    const ts = extractSourceTimestamp('github', { repository: { pushed_at: pushed } }, {});
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
  });

  it('returns null for github when no timestamp fields', () => {
    const ts = extractSourceTimestamp('github', {}, {});
    expect(ts).toBeNull();
  });

  it('returns datadog last_updated directly', () => {
    const ts = extractSourceTimestamp('datadog', { last_updated: 1700000000 }, {});
    expect(ts).toBe(1700000000);
  });

  it('falls back to payload.timestamp for unknown sources', () => {
    const ts = extractSourceTimestamp('generic', { timestamp: '2024-06-01T00:00:00Z' }, {});
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
  });

  it('returns null for generic when no timestamp', () => {
    const ts = extractSourceTimestamp('generic', {}, {});
    expect(ts).toBeNull();
  });
});
