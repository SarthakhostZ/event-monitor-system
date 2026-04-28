'use strict';

/**
 * aiService — OpenAI integration for event severity analysis
 *
 * Public API:
 *   analyzeEvent(event)      — single-event analysis via gpt-4o-mini
 *   batchAnalyze(events[])   — groups by type+source, one AI call per group
 *
 * Cross-cutting concerns (all in-process per Lambda instance):
 *   Circuit breaker  — 5 consecutive failures → 5-minute cooldown → auto-reset
 *   Rate limiter     — token-bucket, max AI_RATE_LIMIT_PER_MINUTE calls/min
 *   Exponential retry— up to AI_MAX_RETRIES attempts before circuit records failure
 *   Confidence gate  — result < MIN_CONFIDENCE → skipped (use rule-engine severity)
 *   Human review flag— confidence < HUMAN_REVIEW_THRESHOLD → flagForReview: true
 *   Cost tracking    — USD cost per call written to MetricsTable
 *
 * State note:
 *   All in-memory state (circuit breaker, rate limiter) resets on cold start.
 *   This is acceptable — instances self-recover without human intervention.
 */

const OpenAI = require('openai');
const { DynamoDBClient }                            = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand }     = require('@aws-sdk/lib-dynamodb');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start)
// ─────────────────────────────────────────────────────────────────────────────
const OPENAI_API_KEY              = process.env.OPENAI_API_KEY;
const OPENAI_MODEL                = process.env.OPENAI_MODEL                || 'gpt-4o-mini';
const AI_ENABLED                  = process.env.AI_ENABLED                  !== 'false';
const AI_MAX_RETRIES              = parseInt(process.env.AI_MAX_RETRIES,                10) || 3;
const CIRCUIT_BREAKER_THRESHOLD   = parseInt(process.env.AI_CIRCUIT_BREAKER_THRESHOLD,  10) || 5;
const CIRCUIT_BREAKER_TIMEOUT_MS  = parseInt(process.env.AI_CIRCUIT_BREAKER_TIMEOUT_MS, 10) || 300_000;
const AI_RATE_LIMIT_PER_MINUTE    = parseInt(process.env.AI_RATE_LIMIT_PER_MINUTE,      10) || 100;
const METRICS_TABLE               = process.env.DYNAMODB_METRICS_TABLE;
const AWS_REGION                  = process.env.AWS_REGION                  || 'ap-south-1';

// Minimum confidence (0–100) to trust the AI result.
// Below this threshold the caller falls back to rule-engine severity.
const MIN_CONFIDENCE          = 50;
// Confidence below this value triggers a human-review flag even if AI is used.
const HUMAN_REVIEW_THRESHOLD  = 70;

// gpt-4o-mini pricing (USD per 1 million tokens, as of 2024-07).
// Update these constants if pricing changes rather than hard-coding elsewhere.
const COST_PER_1M_INPUT_TOKENS  = 0.15;
const COST_PER_1M_OUTPUT_TOKENS = 0.60;

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI CLIENT  (null when key absent — service degrades gracefully)
// ─────────────────────────────────────────────────────────────────────────────
const openaiClient = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB CLIENT  (for MetricsTable cost writes)
// ─────────────────────────────────────────────────────────────────────────────
const _dynamoRaw = new DynamoDBClient({
  region: AWS_REGION,
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
});
const docClient = DynamoDBDocumentClient.from(_dynamoRaw, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER  (in-memory state)
// ─────────────────────────────────────────────────────────────────────────────
const circuitBreaker = {
  failures: 0,
  openedAt: null,

  /** Returns true when the breaker is open (AI calls must be skipped). */
  isOpen() {
    if (this.openedAt === null) return false;

    const elapsed = Date.now() - this.openedAt;
    if (elapsed >= CIRCUIT_BREAKER_TIMEOUT_MS) {
      logger.info('aiService: circuit breaker timeout elapsed — resetting', {
        openedAt:  new Date(this.openedAt).toISOString(),
        elapsedMs: elapsed,
      });
      this.failures = 0;
      this.openedAt = null;
      return false;
    }
    return true;
  },

  recordSuccess() {
    const wasOpen = this.openedAt !== null;
    this.failures = 0;
    this.openedAt = null;
    if (wasOpen) {
      logger.info('aiService: circuit breaker CLOSED after successful probe');
    }
  },

  recordFailure() {
    this.failures += 1;
    logger.warn('aiService: consecutive failure recorded', {
      failures:  this.failures,
      threshold: CIRCUIT_BREAKER_THRESHOLD,
    });

    if (this.failures >= CIRCUIT_BREAKER_THRESHOLD && this.openedAt === null) {
      this.openedAt = Date.now();
      logger.error('aiService: circuit breaker OPENED', {
        failures:   this.failures,
        cooldownMs: CIRCUIT_BREAKER_TIMEOUT_MS,
        resumesAt:  new Date(this.openedAt + CIRCUIT_BREAKER_TIMEOUT_MS).toISOString(),
      });
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITER  (token-bucket, in-memory per Lambda instance)
// ─────────────────────────────────────────────────────────────────────────────
const rateLimiter = {
  tokens:       AI_RATE_LIMIT_PER_MINUTE,
  lastRefillAt: Date.now(),

  /**
   * Consume one token, waiting for the bucket to refill if it is empty.
   * Maximum wait is one full refill period (60 s / capacity).
   */
  async acquire() {
    this._refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Bucket empty — wait for the next token to become available, then retry.
    const msPerToken = 60_000 / AI_RATE_LIMIT_PER_MINUTE;
    logger.warn('aiService: rate limit reached — queuing call', { waitMs: Math.ceil(msPerToken) });
    await sleep(msPerToken);

    this._refill();
    this.tokens = Math.max(0, this.tokens - 1);
  },

  _refill() {
    const now        = Date.now();
    const elapsed    = now - this.lastRefillAt;
    const tokensToAdd = (elapsed / 60_000) * AI_RATE_LIMIT_PER_MINUTE;
    this.tokens      = Math.min(AI_RATE_LIMIT_PER_MINUTE, this.tokens + tokensToAdd);
    this.lastRefillAt = now;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS
// ─────────────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are an event severity analyzer for a monitoring system. \
Analyze the event provided by the user and respond with ONLY a valid JSON object — no markdown, \
no code fences, no extra text.

Required JSON fields:
  "summary"        — concise description of what happened (max 100 words)
  "severity"       — your assessment: one of "low", "medium", "high", "critical"
  "recommendation" — the recommended action for an on-call engineer
  "rootCause"      — your hypothesis about the underlying cause
  "confidence"     — integer 0–100 indicating how confident you are in the severity assessment`;

const BATCH_SYSTEM_PROMPT = `You are an event severity analyzer for a monitoring system. \
You will receive multiple events of the same type and source. Analyze each event and respond with \
ONLY a valid JSON object — no markdown, no code fences, no extra text.

Required JSON structure:
{
  "analyses": [
    {
      "index":          0,
      "summary":        "concise description (max 100 words)",
      "severity":       "low | medium | high | critical",
      "recommendation": "recommended on-call action",
      "rootCause":      "hypothesis about the underlying cause",
      "confidence":     0-100
    }
  ]
}

Produce exactly one analysis object per input event, preserving the input index order.`;

/**
 * Build a single-event user prompt.
 */
function buildUserPrompt(event) {
  const metadataStr = event.metadata ? JSON.stringify(event.metadata, null, 2) : 'none';
  return [
    `Title:       ${event.title}`,
    `Type:        ${event.type}`,
    `Source:      ${event.source}`,
    `Severity:    ${event.severity}  (rule-engine assessment — you may override)`,
    `Description: ${event.description || 'none'}`,
    `Metadata:\n${metadataStr}`,
  ].join('\n');
}

/**
 * Build a batch user prompt for events that share the same type+source group.
 */
function buildBatchUserPrompt(events) {
  return events.map((event, idx) => {
    const metadataStr = event.metadata ? JSON.stringify(event.metadata, null, 2) : 'none';
    return [
      `--- Event ${idx} (eventId: ${event.eventId || idx}) ---`,
      `Title:       ${event.title}`,
      `Type:        ${event.type}`,
      `Source:      ${event.source}`,
      `Severity:    ${event.severity}  (rule-engine assessment)`,
      `Description: ${event.description || 'none'}`,
      `Metadata:\n${metadataStr}`,
    ].join('\n');
  }).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze a single event with OpenAI.
 *
 * Returns one of:
 *   Success:
 *     { summary, severity, recommendation, rootCause, confidence,
 *       flagForReview, tokenUsage, cost, durationMs }
 *   Skipped (use rule-engine severity):
 *     { skipped: true, reason: string, tokenUsage?, cost?, durationMs? }
 *
 * Callers must:
 *   1. Check `result.skipped` and fall back to rule-engine severity when true.
 *   2. Check `result.flagForReview` and route to human triage queue when true.
 *   3. Note: tokenUsage and cost are already written to MetricsTable by this function.
 *
 * @param {object} event - Plain event object
 * @returns {Promise<object>}
 */
async function analyzeEvent(event) {
  const log = logger.child({ fn: 'aiService.analyzeEvent', eventId: event.eventId });

  // ── Pre-flight guards ──────────────────────────────────────────────────────
  if (!AI_ENABLED) {
    log.debug('AI disabled via AI_ENABLED env var — skipping');
    return { skipped: true, reason: 'AI_ENABLED is false' };
  }

  if (!openaiClient) {
    log.warn('OPENAI_API_KEY not configured — skipping AI analysis');
    return { skipped: true, reason: 'OPENAI_API_KEY not configured' };
  }

  if (circuitBreaker.isOpen()) {
    log.warn('Circuit breaker is OPEN — skipping AI analysis', {
      openedAt: new Date(circuitBreaker.openedAt).toISOString(),
      failures: circuitBreaker.failures,
    });
    return { skipped: true, reason: 'circuit breaker open' };
  }

  // ── Rate limit ─────────────────────────────────────────────────────────────
  await rateLimiter.acquire();

  // ── Retry loop ─────────────────────────────────────────────────────────────
  const userPrompt = buildUserPrompt(event);
  let lastError;

  for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
    const attemptStart = Date.now();

    try {
      log.debug('Calling OpenAI', { attempt, model: OPENAI_MODEL });

      const response = await openaiClient.chat.completions.create({
        model:           OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens:  512,
      });

      const durationMs = Date.now() - attemptStart;
      const usage      = response.usage ?? {};
      const tokenUsage = {
        promptTokens:     usage.prompt_tokens     || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens:      usage.total_tokens      || 0,
      };
      const cost = calculateCost(tokenUsage);

      log.info('OpenAI response received', {
        attempt,
        durationMs,
        ...tokenUsage,
        costUsd: cost,
      });

      // ── Parse structured JSON ──────────────────────────────────────────────
      let parsed;
      try {
        parsed = JSON.parse(response.choices[0].message.content);
      } catch {
        log.warn('AI returned non-JSON content — treating as failure', {
          attempt,
          rawContent: response.choices[0].message.content?.slice(0, 200),
        });
        throw new Error('AI returned invalid JSON');
      }

      // ── Validate required fields ───────────────────────────────────────────
      if (!validateAnalysisShape(parsed)) {
        log.warn('AI response missing required fields — treating as failure', {
          attempt,
          keys: Object.keys(parsed),
        });
        throw new Error('AI response failed schema validation');
      }

      const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 0));

      // Store cost regardless of confidence outcome — the API call was made.
      await storeCostMetric(cost, tokenUsage, event.eventId);

      // ── Confidence gate ────────────────────────────────────────────────────
      if (confidence < MIN_CONFIDENCE) {
        log.warn('AI confidence below threshold — falling back to rule-engine severity', {
          confidence,
          threshold:  MIN_CONFIDENCE,
          aiSeverity: parsed.severity,
        });
        circuitBreaker.recordSuccess();
        return {
          skipped:    true,
          reason:     `confidence ${confidence} < threshold ${MIN_CONFIDENCE}`,
          flagForReview: true,
          tokenUsage,
          cost,
          durationMs,
        };
      }

      circuitBreaker.recordSuccess();

      return {
        summary:        String(parsed.summary        || '').slice(0, 500),
        severity:       normalizeSeverity(parsed.severity),
        recommendation: String(parsed.recommendation || ''),
        rootCause:      String(parsed.rootCause      || ''),
        confidence,
        flagForReview:  confidence < HUMAN_REVIEW_THRESHOLD,
        tokenUsage,
        cost,
        durationMs,
      };

    } catch (err) {
      lastError = err;
      const attemptMs = Date.now() - attemptStart;

      log.warn('OpenAI attempt failed', {
        attempt,
        maxRetries: AI_MAX_RETRIES,
        attemptMs,
        error:      err.message,
        errorType:  err.constructor?.name,
      });

      if (attempt < AI_MAX_RETRIES) {
        const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 10_000);
        log.debug('Retrying after backoff', { delayMs: delay, nextAttempt: attempt + 1 });
        await sleep(delay);
      }
    }
  }

  // ── All retries exhausted ──────────────────────────────────────────────────
  circuitBreaker.recordFailure();
  log.error('All AI retries exhausted — falling back to rule-engine severity', {
    attempts: AI_MAX_RETRIES,
    error:    lastError?.message,
  });

  return {
    skipped: true,
    reason:  'all retries exhausted',
    error:   lastError?.message,
  };
}

/**
 * Analyze multiple events with cost-optimized batching.
 *
 * Events are grouped by `type + source`.  One AI call is made per group so
 * that similar events share the prompt context, reducing token overhead.
 *
 * Returns an array in the same order as the input `events` array.  Each
 * element mirrors the shape returned by `analyzeEvent` with an added
 * `eventId` field for correlation.
 *
 * @param {object[]} events - Array of plain event objects
 * @returns {Promise<object[]>}
 */
async function batchAnalyze(events) {
  if (!Array.isArray(events) || events.length === 0) return [];

  // ── Group by type + source ─────────────────────────────────────────────────
  const groups = new Map();
  events.forEach((event, originalIndex) => {
    const key = `${event.type || 'unknown'}::${event.source || 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ event, originalIndex });
  });

  // Placeholder results array — filled as each group resolves.
  const results = new Array(events.length).fill(null);

  // Process groups concurrently (each group is still serialised internally
  // through the rate-limiter and circuit breaker).
  await Promise.all(
    Array.from(groups.entries()).map(([groupKey, members]) =>
      _analyzeGroup(groupKey, members, results),
    ),
  );

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE — batch group analysis
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyze one type+source group of events with a single AI call.
 * Writes analysis objects back into the shared `results` array by originalIndex.
 *
 * @param {string}   groupKey      - "type::source" label for logging
 * @param {Array}    members       - [{ event, originalIndex }, ...]
 * @param {object[]} results       - Shared output array (mutated in-place)
 */
async function _analyzeGroup(groupKey, members, results) {
  const log = logger.child({ fn: 'aiService._analyzeGroup', groupKey, size: members.length });

  // Single-event groups can reuse the cheaper single-event path.
  if (members.length === 1) {
    const { event, originalIndex } = members[0];
    results[originalIndex] = { eventId: event.eventId, ...(await analyzeEvent(event)) };
    return;
  }

  // ── Pre-flight guards (same as analyzeEvent) ───────────────────────────────
  if (!AI_ENABLED) {
    members.forEach(({ event, originalIndex }) => {
      results[originalIndex] = { eventId: event.eventId, skipped: true, reason: 'AI_ENABLED is false' };
    });
    return;
  }

  if (!openaiClient) {
    members.forEach(({ event, originalIndex }) => {
      results[originalIndex] = { eventId: event.eventId, skipped: true, reason: 'OPENAI_API_KEY not configured' };
    });
    return;
  }

  if (circuitBreaker.isOpen()) {
    log.warn('Circuit breaker open — skipping batch group');
    members.forEach(({ event, originalIndex }) => {
      results[originalIndex] = { eventId: event.eventId, skipped: true, reason: 'circuit breaker open' };
    });
    return;
  }

  // ── Rate limit (one token per batch call, not per event) ──────────────────
  await rateLimiter.acquire();

  const groupEvents  = members.map(m => m.event);
  const userPrompt   = buildBatchUserPrompt(groupEvents);
  let lastError;

  for (let attempt = 1; attempt <= AI_MAX_RETRIES; attempt++) {
    const attemptStart = Date.now();

    try {
      log.debug('Calling OpenAI for batch group', { attempt, model: OPENAI_MODEL, events: groupEvents.length });

      const response = await openaiClient.chat.completions.create({
        model:           OPENAI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: BATCH_SYSTEM_PROMPT },
          { role: 'user',   content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens:  512 * members.length,
      });

      const durationMs = Date.now() - attemptStart;
      const usage      = response.usage ?? {};
      const tokenUsage = {
        promptTokens:     usage.prompt_tokens     || 0,
        completionTokens: usage.completion_tokens || 0,
        totalTokens:      usage.total_tokens      || 0,
      };
      const totalCost = calculateCost(tokenUsage);
      // Divide cost evenly across events in the group.
      const costPerEvent = members.length > 0 ? totalCost / members.length : totalCost;

      log.info('Batch OpenAI response received', {
        attempt, durationMs, ...tokenUsage,
        totalCostUsd: totalCost,
        costPerEvent,
        eventCount: members.length,
      });

      // ── Parse ──────────────────────────────────────────────────────────────
      let parsed;
      try {
        parsed = JSON.parse(response.choices[0].message.content);
      } catch {
        throw new Error('Batch AI returned invalid JSON');
      }

      if (!Array.isArray(parsed?.analyses) || parsed.analyses.length !== members.length) {
        throw new Error(
          `Batch AI returned ${parsed?.analyses?.length ?? 0} analyses for ${members.length} events`,
        );
      }

      // Store aggregated cost once per group call.
      await storeCostMetric(totalCost, tokenUsage, `batch:${groupKey}`);

      circuitBreaker.recordSuccess();

      // ── Map analyses back to original indices ──────────────────────────────
      parsed.analyses.forEach((analysis, idx) => {
        const { event, originalIndex } = members[idx];
        const confidence = Math.min(100, Math.max(0, Number(analysis.confidence) || 0));

        if (confidence < MIN_CONFIDENCE) {
          results[originalIndex] = {
            eventId:      event.eventId,
            skipped:      true,
            reason:       `confidence ${confidence} < threshold ${MIN_CONFIDENCE}`,
            flagForReview: true,
            tokenUsage:   _splitTokenUsage(tokenUsage, members.length),
            cost:          costPerEvent,
            durationMs,
          };
        } else {
          results[originalIndex] = {
            eventId:        event.eventId,
            summary:        String(analysis.summary        || '').slice(0, 500),
            severity:       normalizeSeverity(analysis.severity),
            recommendation: String(analysis.recommendation || ''),
            rootCause:      String(analysis.rootCause      || ''),
            confidence,
            flagForReview:  confidence < HUMAN_REVIEW_THRESHOLD,
            tokenUsage:     _splitTokenUsage(tokenUsage, members.length),
            cost:            costPerEvent,
            durationMs,
          };
        }
      });

      return;

    } catch (err) {
      lastError = err;
      log.warn('Batch OpenAI attempt failed', {
        attempt, maxRetries: AI_MAX_RETRIES,
        error: err.message,
      });

      if (attempt < AI_MAX_RETRIES) {
        const delay = Math.min(Math.pow(2, attempt - 1) * 1000, 10_000);
        await sleep(delay);
      }
    }
  }

  // ── All retries exhausted — fall back each event individually ──────────────
  circuitBreaker.recordFailure();
  log.error('Batch retries exhausted — falling back to individual analysis per event', {
    attempts: AI_MAX_RETRIES,
    error:    lastError?.message,
  });

  // Individual fallback still uses analyzeEvent which handles its own circuit
  // breaker state (now likely open after the group failures above).
  await Promise.all(
    members.map(async ({ event, originalIndex }) => {
      results[originalIndex] = { eventId: event.eventId, ...(await analyzeEvent(event)) };
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COST TRACKING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate USD cost for a single OpenAI call using gpt-4o-mini pricing.
 *
 * @param {{ promptTokens: number, completionTokens: number }} tokenUsage
 * @returns {number}  cost in USD, rounded to 8 decimal places
 */
function calculateCost(tokenUsage) {
  const inputCost  = (tokenUsage.promptTokens     / 1_000_000) * COST_PER_1M_INPUT_TOKENS;
  const outputCost = (tokenUsage.completionTokens / 1_000_000) * COST_PER_1M_OUTPUT_TOKENS;
  return +(inputCost + outputCost).toFixed(8);
}

/**
 * Persist the cost of one AI call to MetricsTable using an atomic ADD.
 *
 * MetricKey pattern: "ai_cost:<YYYY-MM-DDTHH>"
 * A separate counter tracks total tokens: "ai_tokens:<YYYY-MM-DDTHH>"
 *
 * Errors are swallowed — cost tracking must never block event processing.
 *
 * @param {number} cost       - USD cost for this call
 * @param {object} tokenUsage - { promptTokens, completionTokens, totalTokens }
 * @param {string} reference  - eventId or "batch:<key>" for log context
 */
async function storeCostMetric(cost, tokenUsage, reference) {
  if (!METRICS_TABLE) {
    logger.debug('aiService: DYNAMODB_METRICS_TABLE not set — skipping cost metric write');
    return;
  }

  const window    = new Date().toISOString().slice(0, 13);   // "YYYY-MM-DDTHH"
  const metricKey = `ai_cost:${window}`;
  const ttl       = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;  // 90-day expiry

  try {
    await Promise.all([
      // Rolling cost accumulator (USD as a decimal stored as Number).
      docClient.send(new UpdateCommand({
        TableName: METRICS_TABLE,
        Key:       { metricKey, timestamp: window },
        UpdateExpression: [
          'SET #unit       = if_not_exists(#unit,       :unit)',
          '    #dimensions = if_not_exists(#dimensions, :dimensions)',
          '    #ttl        = if_not_exists(#ttl,        :ttl)',
          'ADD #value :cost',
        ].join(', '),
        ExpressionAttributeNames: {
          '#value':      'value',
          '#unit':       'unit',
          '#dimensions': 'dimensions',
          '#ttl':        'ttl',
        },
        ExpressionAttributeValues: {
          ':cost':       cost,
          ':unit':       'USD',
          ':dimensions': { model: OPENAI_MODEL },
          ':ttl':        ttl,
        },
      })),

      // Rolling token accumulator.
      docClient.send(new UpdateCommand({
        TableName: METRICS_TABLE,
        Key:       { metricKey: `ai_tokens:${window}`, timestamp: window },
        UpdateExpression: [
          'SET #unit       = if_not_exists(#unit,       :unit)',
          '    #dimensions = if_not_exists(#dimensions, :dimensions)',
          '    #ttl        = if_not_exists(#ttl,        :ttl)',
          'ADD #value :tokens',
        ].join(', '),
        ExpressionAttributeNames: {
          '#value':      'value',
          '#unit':       'unit',
          '#dimensions': 'dimensions',
          '#ttl':        'ttl',
        },
        ExpressionAttributeValues: {
          ':tokens':     tokenUsage.totalTokens,
          ':unit':       'Tokens',
          ':dimensions': { model: OPENAI_MODEL },
          ':ttl':        ttl,
        },
      })),
    ]);

    logger.debug('aiService: cost metric stored', {
      metricKey,
      costUsd:     cost,
      totalTokens: tokenUsage.totalTokens,
      reference,
    });

  } catch (err) {
    logger.warn('aiService: failed to write cost metric — continuing', {
      metricKey,
      reference,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

/**
 * Coerce an arbitrary AI-returned severity string to a valid domain value.
 * Defaults to 'medium' so unknowns are visible (neither suppressed nor over-alarmed).
 */
function normalizeSeverity(value) {
  const candidate = String(value || '').toLowerCase().trim();
  return VALID_SEVERITIES.has(candidate) ? candidate : 'medium';
}

/**
 * Verify that an AI analysis object has all required fields.
 */
function validateAnalysisShape(obj) {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    typeof obj.summary        === 'string' &&
    typeof obj.severity       === 'string' &&
    typeof obj.recommendation === 'string' &&
    typeof obj.rootCause      === 'string' &&
    (typeof obj.confidence === 'number' || typeof obj.confidence === 'string')
  );
}

/**
 * Divide batch token usage evenly across events in a group.
 * Values are floored to integers to avoid floating-point noise.
 */
function _splitTokenUsage(tokenUsage, count) {
  return {
    promptTokens:     Math.floor(tokenUsage.promptTokens     / count),
    completionTokens: Math.floor(tokenUsage.completionTokens / count),
    totalTokens:      Math.floor(tokenUsage.totalTokens      / count),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  analyzeEvent,
  batchAnalyze,

  // Exposed for unit tests — callers must not depend on these in production.
  _circuitBreaker:     circuitBreaker,
  _rateLimiter:        rateLimiter,
  _normalizeSeverity:  normalizeSeverity,
  _validateAnalysis:   validateAnalysisShape,
  _buildUserPrompt:    buildUserPrompt,
  _buildBatchPrompt:   buildBatchUserPrompt,
  _calculateCost:      calculateCost,
};
