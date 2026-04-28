'use strict';

/**
 * dynamoService — DynamoDB operations for the eventProcessor Lambda
 *
 * Responsibilities:
 *   saveEvent()           — conditional PutItem on EventsTable (idempotency guard)
 *   incrementEventMetrics() — atomic ADD counters on MetricsTable for
 *                             events_by_source, events_by_severity, events_by_type
 *
 * Clients are initialised once at module load (cold start) and reused across
 * warm invocations.  Table names are read from environment variables so the
 * same code runs in dev / staging / prod without changes.
 */

const { DynamoDBClient }                                          = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand }       = require('@aws-sdk/lib-dynamodb');

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start)
// ─────────────────────────────────────────────────────────────────────────────
const REGION        = process.env.AWS_REGION             || 'ap-south-1';
const EVENTS_TABLE  = process.env.DYNAMODB_EVENTS_TABLE;
const METRICS_TABLE = process.env.DYNAMODB_METRICS_TABLE;

const METRIC_TTL_SECS = 90 * 24 * 60 * 60;   // counters expire after 90 days

// ─────────────────────────────────────────────────────────────────────────────
// AWS CLIENTS  (reused across warm invocations)
// ─────────────────────────────────────────────────────────────────────────────
const dynamoOpts = {
  region: REGION,
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
};

const _client   = new DynamoDBClient(dynamoOpts);
const docClient = DynamoDBDocumentClient.from(_client, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write an event to EventsTable with an idempotency guard.
 *
 * Uses a conditional PutItem: `attribute_not_exists(eventId)`.
 * If the event was already written (SQS redelivery or concurrent duplicates)
 * the function returns `false` instead of throwing — the caller should skip
 * metric increments and treat the message as successfully handled.
 *
 * @param {object} event - Fully-formed event object (all fields set by processor)
 * @returns {Promise<boolean>}  true = written, false = duplicate (already exists)
 * @throws  Any non-idempotency DynamoDB error (throttling, validation, …)
 */
async function saveEvent(event) {
  const log = logger.child({ fn: 'dynamoService.saveEvent', eventId: event.eventId });

  try {
    await docClient.send(new PutCommand({
      TableName:           EVENTS_TABLE,
      Item:                event,
      ConditionExpression: 'attribute_not_exists(eventId)',
    }));

    log.debug('Event saved to EventsTable');
    return true;

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      log.warn('Duplicate eventId — conditional write rejected', { eventId: event.eventId });
      return false;
    }
    log.error('DynamoDB PutItem failed', { error: err.message, code: err.name });
    throw err;
  }
}

/**
 * Atomically increment three per-hour event counters in MetricsTable.
 *
 * Counters written:
 *   events_by_source:<source>:<YYYY-MM-DDTHH>
 *   events_by_severity:<severity>:<YYYY-MM-DDTHH>
 *   events_by_type:<type>:<YYYY-MM-DDTHH>
 *
 * Each update uses DynamoDB ADD semantics so:
 *   - If the item doesn't exist it is created with value = 1.
 *   - Concurrent Lambda invocations increment atomically — no lost updates.
 *   - A TTL is set on first write so counters self-expire after 90 days.
 *
 * Metric failures are logged but do NOT propagate — counters are best-effort
 * and should never cause an event to land in the DLQ.
 *
 * @param {object} event - Saved event (source, severity, type are required)
 * @returns {Promise<void>}
 */
async function incrementEventMetrics(event) {
  const { source, severity, type } = event;
  const window = hourWindow(new Date());
  const ttl    = Math.floor(Date.now() / 1000) + METRIC_TTL_SECS;

  const counters = [
    { metricKey: `events_by_source:${source}:${window}`,   dimensions: { source } },
    { metricKey: `events_by_severity:${severity}:${window}`, dimensions: { severity } },
    { metricKey: `events_by_type:${type}:${window}`,       dimensions: { type } },
  ];

  // Fire all three increments concurrently; catch each independently.
  const results = await Promise.allSettled(
    counters.map((counter) => incrementCounter(counter.metricKey, counter.dimensions, ttl)),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      logger.warn('Metric increment failed — skipping', {
        fn:        'dynamoService.incrementEventMetrics',
        metricKey: counters[i].metricKey,
        eventId:   event.eventId,
        error:     result.reason?.message,
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically ADD 1 to the `value` attribute of a MetricsTable item.
 * Sets `unit`, `dimensions`, and `ttl` on first write via SET if_not_exists.
 *
 * @param {string} metricKey
 * @param {object} dimensions
 * @param {number} ttl         Unix epoch expiry
 */
async function incrementCounter(metricKey, dimensions, ttl) {
  const timestamp = new Date().toISOString().slice(0, 13); // "YYYY-MM-DDTHH"

  await docClient.send(new UpdateCommand({
    TableName: METRICS_TABLE,
    Key:       { metricKey, timestamp },
    UpdateExpression: [
      'SET #unit        = if_not_exists(#unit,        :unit)',
      '    #dimensions  = if_not_exists(#dimensions,  :dimensions)',
      '    #ttl         = if_not_exists(#ttl,         :ttl)',
      'ADD #value :one',
    ].join(', '),
    ExpressionAttributeNames: {
      '#value':      'value',
      '#unit':       'unit',
      '#dimensions': 'dimensions',
      '#ttl':        'ttl',
    },
    ExpressionAttributeValues: {
      ':one':        1,
      ':unit':       'Count',
      ':dimensions': dimensions,
      ':ttl':        ttl,
    },
  }));
}

/** Hourly window string — "YYYY-MM-DDTHH" — used as the counter's sort key. */
function hourWindow(date) {
  return date.toISOString().slice(0, 13);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  saveEvent,
  incrementEventMetrics,
};
