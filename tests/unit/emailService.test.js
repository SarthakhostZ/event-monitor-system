'use strict';

/**
 * Unit tests for src/services/emailService.js
 *
 * nodemailer is mocked so no real SMTP connection is made.
 * The config module is mocked to control SMTP presence/absence per test.
 */

// ─────────────────────────────────────────────────────────────────────────────
// MOCKS — set up before any require() of the module under test
// ─────────────────────────────────────────────────────────────────────────────

const mockSendMail = jest.fn();
const mockClose    = jest.fn();

jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({
    sendMail: mockSendMail,
    close:    mockClose,
  })),
}));

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// Config is mutable — individual tests override email fields as needed.
const mockConfig = {
  email: {
    host:    'smtp.example.com',
    port:    587,
    secure:  false,
    user:    'user@example.com',
    pass:    'secret',
    from:    'noreply@example.com',
    alertTo: 'ops@example.com',
  },
};
jest.mock('../../src/config', () => mockConfig);

// ─────────────────────────────────────────────────────────────────────────────
// MODULE UNDER TEST  (required after mocks are registered)
// ─────────────────────────────────────────────────────────────────────────────
const emailService = require('../../src/services/emailService');

// ─────────────────────────────────────────────────────────────────────────────
// FIXTURES
// ─────────────────────────────────────────────────────────────────────────────

const baseEvent = {
  eventId:     'evt-001',
  title:       'Database connection pool exhausted',
  description: 'All 100 connections are in use.',
  severity:    'critical',
  type:        'error',
  source:      'api',
  timestamp:   '2026-04-11T10:00:00.000Z',
  metadata:    { host: 'db-prod-1', port: '5432' },
  analyzedBy:  'ai',
};

const baseAnalysis = {
  aiSummary:        'Connection pool saturated under peak load.',
  aiRecommendation: 'Scale the connection pool or throttle upstream traffic.',
  aiRootCause:      'Traffic spike at 09:55 UTC exceeded pool capacity.',
  confidence:       0.92,
  analyzedBy:       'ai',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function resetTransporterPool() {
  // Force the module to recreate the pooled transporter on next call.
  emailService._resetTransporter();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockResolvedValue({ messageId: '<msg-123@smtp.example.com>' });
  // Restore valid SMTP config before each test.
  mockConfig.email.host    = 'smtp.example.com';
  mockConfig.email.alertTo = 'ops@example.com';
  resetTransporterPool();
});

afterAll(() => {
  resetTransporterPool();
});

// ─────────────────────────────────────────────────────────────────────────────
// sendAlert — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe('sendAlert', () => {
  it('returns a messageId on successful send', async () => {
    const result = await emailService.sendAlert(baseEvent, baseAnalysis);
    expect(result.messageId).toBe('<msg-123@smtp.example.com>');
    expect(result.skipped).toBeUndefined();
  });

  it('calls sendMail with the correct from/to addresses', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.from).toBe('noreply@example.com');
    expect(call.to).toBe('ops@example.com');
  });

  it('includes the severity label in the subject', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { subject } = mockSendMail.mock.calls[0][0];
    expect(subject).toContain('[CRITICAL]');
  });

  it('includes the event title in the subject', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { subject } = mockSendMail.mock.calls[0][0];
    expect(subject).toContain(baseEvent.title);
  });

  it('renders the event ID in the HTML', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain(baseEvent.eventId);
  });

  it('renders the AI summary in the HTML', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('Connection pool saturated');
  });

  it('renders the AI recommendation in the HTML', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('Scale the connection pool');
  });

  it('renders the AI root cause when present', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('Traffic spike');
  });

  it('renders confidence percentage in the HTML', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('92%');
  });

  it('renders metadata key-value rows in the HTML', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('db-prod-1');
    expect(html).toContain('5432');
  });

  it('omits the AI section when no analysis is provided', async () => {
    const eventNoAI = { ...baseEvent, analyzedBy: 'rule-engine', aiSummary: undefined };
    await emailService.sendAlert(eventNoAI, {});
    const { html } = mockSendMail.mock.calls[0][0];
    // The rule-engine fallback note should appear instead.
    expect(html).toContain('rule engine');
    expect(html).not.toContain('AI&#8209;Powered');
  });

  it('omits the metadata section when metadata is empty', async () => {
    const eventNoMeta = { ...baseEvent, metadata: {} };
    await emailService.sendAlert(eventNoMeta, baseAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    // The <h2> heading and the table should be absent; the HTML comment may remain.
    expect(html).not.toMatch(/<h2[^>]*>\s*Metadata\s*<\/h2>/);
    expect(html).not.toContain('db-prod-1');
  });

  it('HTML-escapes user-supplied values (XSS prevention)', async () => {
    const xssEvent = {
      ...baseEvent,
      title:       '<script>alert(1)</script>',
      description: '"><img src=x onerror=alert(2)>',
    };
    await emailService.sendAlert(xssEvent, {});
    const { html } = mockSendMail.mock.calls[0][0];
    // Tags must be escaped — unescaped <script> or <img> are the actual XSS vectors.
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img');
  });

  it('uses correct severity colour for high events', async () => {
    const highEvent = { ...baseEvent, severity: 'high' };
    await emailService.sendAlert(highEvent, {});
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('#ea580c');  // high background colour
  });

  it('uses correct severity colour for medium events', async () => {
    const medEvent = { ...baseEvent, severity: 'medium' };
    await emailService.sendAlert(medEvent, {});
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('#d97706');
  });

  it('uses fallback colour for an unknown severity', async () => {
    const unknownEvent = { ...baseEvent, severity: 'extreme' };
    await emailService.sendAlert(unknownEvent, {});
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('#6b7280');
  });

  it('analysis fields take precedence over duplicate event fields', async () => {
    const eventWithFlat = {
      ...baseEvent,
      aiSummary:    'old summary from event',
      analyzedBy:   'rule-engine',
    };
    const freshAnalysis = {
      aiSummary:  'new summary from analysis',
      analyzedBy: 'ai',
    };
    await emailService.sendAlert(eventWithFlat, freshAnalysis);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('new summary from analysis');
    expect(html).not.toContain('old summary from event');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendAlert — SMTP not configured
// ─────────────────────────────────────────────────────────────────────────────

describe('sendAlert — SMTP not configured', () => {
  beforeEach(() => {
    mockConfig.email.host = '';
    resetTransporterPool();
  });

  it('returns { skipped: true, messageId: null }', async () => {
    const result = await emailService.sendAlert(baseEvent, baseAnalysis);
    expect(result.skipped).toBe(true);
    expect(result.messageId).toBeNull();
  });

  it('does not call sendMail', async () => {
    await emailService.sendAlert(baseEvent, baseAnalysis);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendAlert — email validation
// ─────────────────────────────────────────────────────────────────────────────

describe('sendAlert — email validation', () => {
  it('throws when recipient address is missing', async () => {
    mockConfig.email.alertTo = '';
    await expect(emailService.sendAlert(baseEvent, baseAnalysis))
      .rejects.toThrow('invalid');
  });

  it('throws when recipient address is malformed', async () => {
    mockConfig.email.alertTo = 'not-an-email';
    await expect(emailService.sendAlert(baseEvent, baseAnalysis))
      .rejects.toThrow('invalid');
  });

  it('accepts a valid address with subdomains', async () => {
    mockConfig.email.alertTo = 'team@alerts.company.io';
    mockSendMail.mockResolvedValue({ messageId: '<ok@smtp>' });
    await expect(emailService.sendAlert(baseEvent, baseAnalysis)).resolves.not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendAlert — SMTP failure propagates
// ─────────────────────────────────────────────────────────────────────────────

describe('sendAlert — SMTP failure', () => {
  it('throws the SMTP error so the caller can handle retry logic', async () => {
    mockSendMail.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(emailService.sendAlert(baseEvent, baseAnalysis))
      .rejects.toThrow('ECONNREFUSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendAlertEmail — backward-compat wrapper
// ─────────────────────────────────────────────────────────────────────────────

describe('sendAlertEmail', () => {
  it('delegates to sendAlert and returns a messageId', async () => {
    const flatEventData = {
      ...baseEvent,
      aiSummary:        baseAnalysis.aiSummary,
      aiRecommendation: baseAnalysis.aiRecommendation,
      aiRootCause:      baseAnalysis.aiRootCause,
      aiConfidence:     baseAnalysis.confidence,
      analyzedBy:       'ai',
    };
    const result = await emailService.sendAlertEmail(flatEventData);
    expect(result.messageId).toBe('<msg-123@smtp.example.com>');
  });

  it('returns skipped:true when SMTP is not configured', async () => {
    mockConfig.email.host = '';
    resetTransporterPool();
    const result = await emailService.sendAlertEmail(baseEvent);
    expect(result.skipped).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendDigest — happy paths
// ─────────────────────────────────────────────────────────────────────────────

describe('sendDigest', () => {
  const makeEvent = (severity, title, ts) => ({
    eventId:   `evt-${Math.random().toString(36).slice(2, 8)}`,
    title:     title || `Event (${severity})`,
    severity,
    timestamp: ts || '2026-04-11T08:00:00.000Z',
  });

  const todayEvents = [
    makeEvent('critical', 'DB connection exhausted'),
    makeEvent('critical', 'Payment service down'),
    makeEvent('high',     'API latency spike'),
    makeEvent('high',     'Auth service timeout'),
    makeEvent('medium',   'Disk usage at 85%'),
    makeEvent('low',      'New user signup spike'),
  ];

  const yesterdayEvents = [
    makeEvent('critical', 'DB blip'),
    makeEvent('high',     'Old latency'),
    makeEvent('medium',   'Old disk'),
  ];

  it('returns a messageId on successful send', async () => {
    const result = await emailService.sendDigest(todayEvents, yesterdayEvents);
    expect(result.messageId).toBe('<msg-123@smtp.example.com>');
  });

  it('sends exactly one email', async () => {
    await emailService.sendDigest(todayEvents, yesterdayEvents);
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  it('subject contains the date label', async () => {
    await emailService.sendDigest(todayEvents, [], { date: '2026-04-11' });
    const { subject } = mockSendMail.mock.calls[0][0];
    expect(subject).toContain('2026');
  });

  it('subject contains "Digest"', async () => {
    await emailService.sendDigest(todayEvents, []);
    const { subject } = mockSendMail.mock.calls[0][0];
    expect(subject.toLowerCase()).toContain('digest');
  });

  it('HTML contains the total event count', async () => {
    await emailService.sendDigest(todayEvents, yesterdayEvents);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain(`${todayEvents.length}`);
  });

  it('HTML contains the CRITICAL severity badge', async () => {
    await emailService.sendDigest(todayEvents, []);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('CRITICAL');
  });

  it('shows top critical event titles in the HTML', async () => {
    await emailService.sendDigest(todayEvents, []);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('DB connection exhausted');
  });

  it('lists at most 5 events in the top section', async () => {
    const manyEvents = Array.from({ length: 10 }, (_, i) =>
      makeEvent('critical', `Critical event ${i}`),
    );
    await emailService.sendDigest(manyEvents, []);
    // Count occurrences of event ID prefix pattern in the HTML.
    const { html } = mockSendMail.mock.calls[0][0];
    const trCount = (html.match(/Critical event \d/g) || []).length;
    expect(trCount).toBeLessThanOrEqual(5);
  });

  it('shows the "no critical events" placeholder when none exist', async () => {
    const onlyLowEvents = [makeEvent('low'), makeEvent('medium')];
    await emailService.sendDigest(onlyLowEvents, []);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('No critical or high-severity events');
  });

  it('shows an upward trend indicator when today > yesterday', async () => {
    const many   = Array.from({ length: 10 }, () => makeEvent('low'));
    const few    = Array.from({ length: 3 },  () => makeEvent('low'));
    await emailService.sendDigest(many, few);
    const { html } = mockSendMail.mock.calls[0][0];
    // ⇧ up arrow (HTML entity &#8679; renders as ⇧)
    expect(html).toContain('&#8679;');
  });

  it('shows a downward trend indicator when today < yesterday', async () => {
    const few  = Array.from({ length: 2 }, () => makeEvent('low'));
    const many = Array.from({ length: 8 }, () => makeEvent('low'));
    await emailService.sendDigest(few, many);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('&#8681;');
  });

  it('accepts a custom recipient via opts.to', async () => {
    await emailService.sendDigest(todayEvents, [], { to: 'custom@recipient.com' });
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toBe('custom@recipient.com');
  });

  it('HTML-escapes event titles to prevent XSS in digest', async () => {
    const xssEvents = [makeEvent('critical', '<script>evil()</script>')];
    await emailService.sendDigest(xssEvents, []);
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles empty events array gracefully', async () => {
    const result = await emailService.sendDigest([], []);
    expect(result.messageId).toBe('<msg-123@smtp.example.com>');
    const { html } = mockSendMail.mock.calls[0][0];
    expect(html).toContain('No critical or high-severity events');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendDigest — SMTP not configured
// ─────────────────────────────────────────────────────────────────────────────

describe('sendDigest — SMTP not configured', () => {
  beforeEach(() => {
    mockConfig.email.host = '';
    resetTransporterPool();
  });

  it('returns { skipped: true, messageId: null }', async () => {
    const result = await emailService.sendDigest([]);
    expect(result.skipped).toBe(true);
    expect(result.messageId).toBeNull();
  });

  it('does not call sendMail', async () => {
    await emailService.sendDigest([]);
    expect(mockSendMail).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sendDigest — email validation
// ─────────────────────────────────────────────────────────────────────────────

describe('sendDigest — email validation', () => {
  it('throws for a malformed default recipient', async () => {
    mockConfig.email.alertTo = 'bad-address';
    await expect(emailService.sendDigest([])).rejects.toThrow('invalid');
  });

  it('throws when opts.to is malformed', async () => {
    await expect(emailService.sendDigest([], [], { to: 'not@@valid' }))
      .rejects.toThrow('invalid');
  });
});
