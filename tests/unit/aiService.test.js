'use strict';

/**
 * Unit tests for src/services/aiService.js
 *
 * OpenAI and AWS DynamoDB are fully mocked — no external calls are made.
 * Circuit breaker and rate limiter state is reset between tests.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module mocks  (jest.mock is hoisted; factories run lazily on first require)
// ─────────────────────────────────────────────────────────────────────────────

jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn(() => ({})),
}));

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = jest.fn().mockResolvedValue({});
  return {
    DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockSend })) },
    UpdateCommand: jest.fn((x) => x),
    _mockSend: mockSend,
  };
});

// OpenAI mock — exposes ._mockCreate so tests can control responses.
jest.mock('openai', () => {
  const mockCreate = jest.fn();
  function MockOpenAI() {
    this.chat = { completions: { create: mockCreate } };
  }
  MockOpenAI._mockCreate = mockCreate;
  return MockOpenAI;
});

jest.mock('../../src/utils/logger', () => ({
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  child: jest.fn().mockReturnThis(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Set env before requiring the module (vars are read at cold start)
// ─────────────────────────────────────────────────────────────────────────────
process.env.OPENAI_API_KEY                = 'test-key';
process.env.AI_ENABLED                   = 'true';
process.env.AI_MAX_RETRIES               = '2';
process.env.AI_CIRCUIT_BREAKER_THRESHOLD = '3';
process.env.AI_CIRCUIT_BREAKER_TIMEOUT_MS = '300000';
process.env.AI_RATE_LIMIT_PER_MINUTE     = '1000';  // high limit to avoid blocking in tests

const OpenAI = require('openai');
const mockCreate = OpenAI._mockCreate;

const {
  analyzeEvent,
  batchAnalyze,
  _circuitBreaker,
  _rateLimiter,
  _normalizeSeverity,
  _validateAnalysis,
  _buildUserPrompt,
  _buildBatchPrompt,
  _calculateCost,
} = require('../../src/services/aiService');

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

const baseEvent = {
  eventId:     'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  title:       'Database connection pool exhausted',
  type:        'error',
  source:      'api',
  severity:    'medium',
  description: 'All 100 connections are in use',
  metadata:    { region: 'ap-south-1', service: 'orders' },
};

function makeApiResponse(overrides = {}) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({
          summary:        'Database connection pool exhausted — all connections in use',
          severity:       'high',
          recommendation: 'Scale up connection pool or add read replicas',
          rootCause:      'Traffic spike combined with slow query backlog',
          confidence:     85,
          ...overrides,
        }),
      },
    }],
    usage: {
      prompt_tokens:     120,
      completion_tokens: 60,
      total_tokens:      180,
    },
  };
}

function makeBatchApiResponse(analyses) {
  return {
    choices: [{
      message: {
        content: JSON.stringify({ analyses }),
      },
    }],
    usage: { prompt_tokens: 300, completion_tokens: 150, total_tokens: 450 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset shared state between tests
// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  _circuitBreaker.failures = 0;
  _circuitBreaker.openedAt = null;
  _rateLimiter.tokens = 1000;
  _rateLimiter.lastRefillAt = Date.now();
});

// ─────────────────────────────────────────────────────────────────────────────
// _normalizeSeverity
// ─────────────────────────────────────────────────────────────────────────────

describe('_normalizeSeverity', () => {
  it.each(['low', 'medium', 'high', 'critical'])('passes through valid severity: %s', (sev) => {
    expect(_normalizeSeverity(sev)).toBe(sev);
  });

  it('lowercases uppercase severities', () => {
    expect(_normalizeSeverity('HIGH')).toBe('high');
    expect(_normalizeSeverity('CRITICAL')).toBe('critical');
    expect(_normalizeSeverity('Medium')).toBe('medium');
  });

  it.each([null, undefined, '', 'extreme', 'URGENT'])('returns "medium" for unknown: %s', (val) => {
    expect(_normalizeSeverity(val)).toBe('medium');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _validateAnalysis
// ─────────────────────────────────────────────────────────────────────────────

describe('_validateAnalysis', () => {
  const valid = {
    summary:        'DB down',
    severity:       'high',
    recommendation: 'Restart',
    rootCause:      'OOM',
    confidence:     80,
  };

  it('returns true for a complete valid object', () => {
    expect(_validateAnalysis(valid)).toBe(true);
  });

  it('accepts confidence as a string (AI sometimes returns "85" not 85)', () => {
    expect(_validateAnalysis({ ...valid, confidence: '85' })).toBe(true);
  });

  it.each(['summary', 'severity', 'recommendation', 'rootCause', 'confidence'])(
    'returns false when required field "%s" is missing',
    (field) => {
      const incomplete = { ...valid };
      delete incomplete[field];
      expect(_validateAnalysis(incomplete)).toBe(false);
    },
  );

  it('returns false for null', () => expect(_validateAnalysis(null)).toBe(false));
  it('returns false for a string', () => expect(_validateAnalysis('text')).toBe(false));
  it('returns false for a number', () => expect(_validateAnalysis(42)).toBe(false));
});

// ─────────────────────────────────────────────────────────────────────────────
// _calculateCost
// ─────────────────────────────────────────────────────────────────────────────

describe('_calculateCost', () => {
  it('returns 0 for zero tokens', () => {
    expect(_calculateCost({ promptTokens: 0, completionTokens: 0 })).toBe(0);
  });

  it('charges 0.15 USD per 1M input tokens', () => {
    const cost = _calculateCost({ promptTokens: 1_000_000, completionTokens: 0 });
    expect(cost).toBeCloseTo(0.15, 5);
  });

  it('charges 0.60 USD per 1M output tokens', () => {
    const cost = _calculateCost({ promptTokens: 0, completionTokens: 1_000_000 });
    expect(cost).toBeCloseTo(0.60, 5);
  });

  it('output tokens cost more than input tokens per token', () => {
    const input  = _calculateCost({ promptTokens: 1000, completionTokens: 0 });
    const output = _calculateCost({ promptTokens: 0,    completionTokens: 1000 });
    expect(output).toBeGreaterThan(input);
  });

  it('rounds to 8 decimal places', () => {
    const cost = _calculateCost({ promptTokens: 123, completionTokens: 456 });
    expect(cost).toBe(+cost.toFixed(8));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _buildUserPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('_buildUserPrompt', () => {
  it('includes the event title, type, source, and severity', () => {
    const prompt = _buildUserPrompt(baseEvent);
    expect(prompt).toContain('Database connection pool exhausted');
    expect(prompt).toContain('error');
    expect(prompt).toContain('api');
    expect(prompt).toContain('medium');
  });

  it('includes metadata serialised as JSON', () => {
    const prompt = _buildUserPrompt(baseEvent);
    expect(prompt).toContain('ap-south-1');
    expect(prompt).toContain('orders');
  });

  it('handles missing description gracefully', () => {
    const event  = { ...baseEvent, description: undefined };
    const prompt = _buildUserPrompt(event);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('none');
  });

  it('handles missing metadata gracefully', () => {
    const event  = { ...baseEvent, metadata: undefined };
    const prompt = _buildUserPrompt(event);
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// _buildBatchPrompt
// ─────────────────────────────────────────────────────────────────────────────

describe('_buildBatchPrompt', () => {
  it('includes an entry per event with its index', () => {
    const events = [
      { ...baseEvent, eventId: 'evt-0' },
      { ...baseEvent, eventId: 'evt-1', type: 'warning' },
    ];
    const prompt = _buildBatchPrompt(events);
    expect(prompt).toContain('Event 0');
    expect(prompt).toContain('Event 1');
    expect(prompt).toContain('evt-0');
    expect(prompt).toContain('evt-1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Circuit breaker unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe('_circuitBreaker', () => {
  it('is initially closed (isOpen returns false)', () => {
    expect(_circuitBreaker.isOpen()).toBe(false);
  });

  it('opens after threshold consecutive failures', () => {
    _circuitBreaker.recordFailure(); // 1
    expect(_circuitBreaker.openedAt).toBeNull();
    _circuitBreaker.recordFailure(); // 2
    expect(_circuitBreaker.openedAt).toBeNull();
    _circuitBreaker.recordFailure(); // 3 — threshold reached
    expect(_circuitBreaker.openedAt).not.toBeNull();
    expect(_circuitBreaker.isOpen()).toBe(true);
  });

  it('resets to closed on success after being open', () => {
    for (let i = 0; i < 3; i++) _circuitBreaker.recordFailure();
    expect(_circuitBreaker.isOpen()).toBe(true);

    _circuitBreaker.recordSuccess();
    expect(_circuitBreaker.failures).toBe(0);
    expect(_circuitBreaker.openedAt).toBeNull();
    expect(_circuitBreaker.isOpen()).toBe(false);
  });

  it('auto-closes after the timeout has elapsed', () => {
    for (let i = 0; i < 3; i++) _circuitBreaker.recordFailure();
    // Backdate the openedAt so the timeout appears elapsed.
    _circuitBreaker.openedAt = Date.now() - 300_001;
    expect(_circuitBreaker.isOpen()).toBe(false);  // auto-reset
    expect(_circuitBreaker.failures).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// analyzeEvent
// ─────────────────────────────────────────────────────────────────────────────

describe('analyzeEvent', () => {
  it('returns a full analysis result on a valid OpenAI response', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse());

    const result = await analyzeEvent(baseEvent);

    expect(result.skipped).toBeUndefined();
    expect(result.severity).toBe('high');
    expect(typeof result.summary).toBe('string');
    expect(typeof result.recommendation).toBe('string');
    expect(typeof result.rootCause).toBe('string');
    expect(result.confidence).toBe(85);
    expect(typeof result.tokenUsage.promptTokens).toBe('number');
    expect(typeof result.cost).toBe('number');
    expect(typeof result.durationMs).toBe('number');
  });

  it('sets flagForReview=false when confidence >= 70', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse({ confidence: 80 }));
    const result = await analyzeEvent(baseEvent);
    expect(result.flagForReview).toBe(false);
  });

  it('sets flagForReview=true when 50 <= confidence < 70', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse({ confidence: 60 }));
    const result = await analyzeEvent(baseEvent);
    expect(result.skipped).toBeUndefined();
    expect(result.flagForReview).toBe(true);
  });

  it('returns skipped=true with flagForReview when confidence < 50', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse({ confidence: 40 }));
    const result = await analyzeEvent(baseEvent);
    expect(result.skipped).toBe(true);
    expect(result.flagForReview).toBe(true);
    expect(result.reason).toContain('confidence');
  });

  it('truncates summary to 500 characters', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse({ summary: 'X'.repeat(600) }));
    const result = await analyzeEvent(baseEvent);
    expect(result.summary.length).toBeLessThanOrEqual(500);
  });

  it('normalises an unknown AI severity to "medium"', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse({ severity: 'VERY_BAD' }));
    const result = await analyzeEvent(baseEvent);
    expect(result.severity).toBe('medium');
  });

  it('retries on transient error and succeeds on second attempt', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('Transient network error'))
      .mockResolvedValueOnce(makeApiResponse());

    const result = await analyzeEvent(baseEvent);
    expect(result.skipped).toBeUndefined();
    expect(result.severity).toBe('high');
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('returns skipped=true after all retries are exhausted', async () => {
    mockCreate.mockRejectedValue(new Error('Persistent failure'));

    const result = await analyzeEvent(baseEvent);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('all retries exhausted');
    expect(result.error).toBe('Persistent failure');
    expect(mockCreate).toHaveBeenCalledTimes(2); // AI_MAX_RETRIES=2
  }, 15_000);

  it('increments circuit breaker failure count when all retries fail', async () => {
    mockCreate.mockRejectedValue(new Error('API error'));
    const before = _circuitBreaker.failures;

    await analyzeEvent(baseEvent);

    expect(_circuitBreaker.failures).toBeGreaterThan(before);
  }, 15_000);

  it('returns skipped=true immediately when circuit breaker is open', async () => {
    // Force circuit open
    for (let i = 0; i < 3; i++) _circuitBreaker.recordFailure();
    expect(_circuitBreaker.isOpen()).toBe(true);

    const result = await analyzeEvent(baseEvent);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('circuit breaker open');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('resets circuit breaker on a successful call', async () => {
    _circuitBreaker.failures = 2;
    mockCreate.mockResolvedValueOnce(makeApiResponse());

    await analyzeEvent(baseEvent);

    expect(_circuitBreaker.failures).toBe(0);
    expect(_circuitBreaker.openedAt).toBeNull();
  });

  it('returns skipped=true when AI returns invalid JSON after retries', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{ this is: not json }' } }],
      usage:   { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    const result = await analyzeEvent(baseEvent);
    expect(result.skipped).toBe(true);
  }, 15_000);

  it('returns skipped=true when AI response is missing required fields', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ severity: 'high' }) } }],
      usage:   { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    });

    const result = await analyzeEvent(baseEvent);
    expect(result.skipped).toBe(true);
  }, 15_000);

  it('includes tokenUsage and cost even when confidence falls below threshold', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse({ confidence: 30 }));
    const result = await analyzeEvent(baseEvent);
    expect(result.skipped).toBe(true);
    expect(result.tokenUsage).toBeDefined();
    expect(result.cost).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// batchAnalyze
// ─────────────────────────────────────────────────────────────────────────────

describe('batchAnalyze', () => {
  it('returns an empty array for an empty input array', async () => {
    expect(await batchAnalyze([])).toEqual([]);
  });

  it('returns an empty array for null/undefined input', async () => {
    expect(await batchAnalyze(null)).toEqual([]);
    expect(await batchAnalyze(undefined)).toEqual([]);
  });

  it('routes a single-event group through the single-event path', async () => {
    mockCreate.mockResolvedValueOnce(makeApiResponse());

    const results = await batchAnalyze([baseEvent]);

    expect(results).toHaveLength(1);
    expect(results[0].eventId).toBe(baseEvent.eventId);
    expect(results[0].severity).toBe('high');
  });

  it('groups same type+source events into one batch call', async () => {
    const batchResponse = makeBatchApiResponse([
      { index: 0, summary: 'S0', severity: 'high',   recommendation: 'R0', rootCause: 'C0', confidence: 80 },
      { index: 1, summary: 'S1', severity: 'medium', recommendation: 'R1', rootCause: 'C1', confidence: 75 },
    ]);
    mockCreate.mockResolvedValueOnce(batchResponse);

    const events = [
      { ...baseEvent, eventId: 'evt-a' },
      { ...baseEvent, eventId: 'evt-b' },
    ];

    const results = await batchAnalyze(events);

    expect(results).toHaveLength(2);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(results[0].severity).toBe('high');
    expect(results[1].severity).toBe('medium');
  });

  it('preserves original event ordering in results', async () => {
    const batchResponse = makeBatchApiResponse([
      { index: 0, summary: 'S0', severity: 'critical', recommendation: 'R0', rootCause: 'C0', confidence: 90 },
      { index: 1, summary: 'S1', severity: 'low',      recommendation: 'R1', rootCause: 'C1', confidence: 80 },
    ]);
    mockCreate.mockResolvedValueOnce(batchResponse);

    const events = [
      { ...baseEvent, eventId: 'first',  type: 'error', source: 'api' },
      { ...baseEvent, eventId: 'second', type: 'error', source: 'api' },
    ];

    const results = await batchAnalyze(events);
    expect(results[0].eventId).toBe('first');
    expect(results[0].severity).toBe('critical');
    expect(results[1].eventId).toBe('second');
    expect(results[1].severity).toBe('low');
  });

  it('uses separate calls for events with different type+source groups', async () => {
    mockCreate
      .mockResolvedValueOnce(makeApiResponse({ severity: 'high' }))
      .mockResolvedValueOnce(makeApiResponse({ severity: 'low' }));

    const events = [
      { ...baseEvent, eventId: 'evt-x', type: 'error',   source: 'api' },
      { ...baseEvent, eventId: 'evt-y', type: 'warning', source: 'api' },
    ];

    const results = await batchAnalyze(events);
    expect(results).toHaveLength(2);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it('marks batch result as skipped when circuit breaker is open', async () => {
    for (let i = 0; i < 3; i++) _circuitBreaker.recordFailure();

    const events = [
      { ...baseEvent, eventId: 'evt-a' },
      { ...baseEvent, eventId: 'evt-b' },
    ];

    const results = await batchAnalyze(events);
    results.forEach(r => {
      expect(r.skipped).toBe(true);
      expect(r.reason).toBe('circuit breaker open');
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
