'use strict';

const Joi = require('joi');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const METRIC_UNITS = [
  'Count',        // plain counter (events, alerts, API calls)
  'Milliseconds', // durations
  'Seconds',
  'Bytes',
  'Kilobytes',
  'Megabytes',
  'Tokens',       // AI token usage
  'USD',          // cost tracking
  'Percent',      // error rates, AI confidence
  'None',         // dimensionless gauge
];

// Well-known metricKey prefixes — document the key format here so all writers
// stay consistent without needing a central registry.
//
// Format: "<category>:<dimension>:<window>"
//   events_by_severity:high:2026-04-10T14          — hourly count
//   events_by_source:webhook:2026-04-10            — daily count
//   ai_tokens:gpt-4o-mini:2026-04-10              — daily token total
//   ai_cost:2026-04-10                            — daily USD cost
//   lambda_duration:eventProcessor:2026-04-10T14  — hourly p99 duration
//   rate_limit:api:/events:2026-04-10T14:05        — per-minute bucket
const METRIC_CATEGORIES = [
  'events_by_severity',
  'events_by_source',
  'events_by_type',
  'events_by_status',
  'ai_tokens',
  'ai_cost',
  'ai_confidence',
  'lambda_duration',
  'lambda_errors',
  'alert_by_channel',
  'alert_by_status',
  'rate_limit',
  'custom',
];

const METRIC_TTL_DAYS = 90;   // metrics retained for 90 days

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for writing a metric data point.
 *
 * MetricsTable primary key:
 *   PK: metricKey  (e.g. "events_by_severity:high:2026-04-10T14")
 *   SK: timestamp  (ISO string of when the metric was recorded)
 */
const metricSchema = Joi.object({
  // ── Primary key ───────────────────────────────────────────────────────────
  metricKey: Joi.string()
    .max(256)
    .pattern(/^[a-z_]+:[^:]{1,128}(:[^:]{1,64})?$/, { name: 'metricKey format' })
    .required()
    .description(
      'Composite key: "<category>:<dimension>[:<window>]". ' +
      'e.g. "events_by_severity:high:2026-04-10T14"',
    ),

  timestamp: Joi.string()
    .isoDate()
    .default(() => new Date().toISOString())
    .description('ISO timestamp of this data point (DynamoDB sort key)'),

  // ── Value ─────────────────────────────────────────────────────────────────
  value: Joi.number()
    .required()
    .description('Numeric metric value (counter, gauge, or derived statistic)'),

  unit: Joi.string()
    .valid(...METRIC_UNITS)
    .default('Count')
    .description('Unit of measurement — drives dashboard rendering'),

  // ── Aggregation type ──────────────────────────────────────────────────────
  aggregation: Joi.string()
    .valid('sum', 'avg', 'min', 'max', 'p50', 'p95', 'p99', 'last')
    .default('sum')
    .description('How this metric should be aggregated in dashboard roll-ups'),

  // ── Grouping dimensions ───────────────────────────────────────────────────
  dimensions: Joi.object()
    .pattern(
      Joi.string().max(64),
      Joi.alternatives().try(
        Joi.string().max(256),
        Joi.number(),
        Joi.boolean(),
      ),
    )
    .default({})
    .description(
      'Key-value pairs used to slice/filter metrics in dashboard queries. ' +
      'e.g. { severity: "high", source: "webhook", stage: "prod" }',
    ),

  // ── Windowing metadata ────────────────────────────────────────────────────
  window: Joi.object({
    size:  Joi.string().valid('minute', 'hour', 'day', 'week').default('hour'),
    start: Joi.string().isoDate().optional(),
    end:   Joi.string().isoDate().optional(),
  })
    .optional()
    .description('Aggregation window metadata for time-series dashboard rendering'),

  // ── Source attribution ────────────────────────────────────────────────────
  source: Joi.object({
    function:  Joi.string().max(64).optional(),   // Lambda function name
    requestId: Joi.string().max(128).optional(),  // Lambda request ID for correlation
    eventId:   Joi.string().uuid().optional(),    // related event if applicable
  })
    .optional()
    .description('Which Lambda function / request produced this metric'),

  // ── TTL ───────────────────────────────────────────────────────────────────
  ttl: Joi.number()
    .integer()
    .positive()
    .optional()
    .description('Unix epoch expiry — auto-computed to 90 days from now'),
});

/**
 * Schema for incrementing an existing counter metric via DynamoDB UpdateItem.
 * Used for high-frequency per-severity / per-source counters.
 */
const incrementSchema = Joi.object({
  metricKey:   Joi.string().max(256).required(),
  timestamp:   Joi.string().isoDate().default(() => new Date().toISOString()),
  incrementBy: Joi.number().integer().min(1).default(1),
  unit:        Joi.string().valid(...METRIC_UNITS).default('Count'),
  dimensions:  Joi.object().pattern(Joi.string(), Joi.alternatives().try(Joi.string(), Joi.number())).default({}),
  ttl:         Joi.number().integer().positive().optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a metric data point write payload.
 *
 * @param {object} data
 * @returns {{ value: object, error: Joi.ValidationError|undefined }}
 *
 * @example
 * const { value, error } = validateMetric({
 *   metricKey: 'ai_tokens:gpt-4o-mini:2026-04-10',
 *   value: 1850,
 *   unit: 'Tokens',
 *   dimensions: { model: 'gpt-4o-mini', stage: 'prod' },
 * });
 */
function validateMetric(data) {
  const { value, error } = metricSchema.validate(data, {
    abortEarly:   false,
    stripUnknown: true,
    convert:      true,
  });

  if (error) return { value: null, error };

  if (!value.ttl) {
    value.ttl = computeTtl(METRIC_TTL_DAYS);
  }

  return { value, error: undefined };
}

/**
 * Validate an increment operation payload.
 *
 * @param {object} data
 * @returns {{ value: object, error: Joi.ValidationError|undefined }}
 */
function validateIncrement(data) {
  const { value, error } = incrementSchema.validate(data, {
    abortEarly:   false,
    stripUnknown: true,
    convert:      true,
  });

  if (error) return { value: null, error };

  if (!value.ttl) {
    value.ttl = computeTtl(METRIC_TTL_DAYS);
  }

  return { value, error: undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// METRIC KEY BUILDERS
// Centralise key construction so all writers use the exact same format.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the metricKey for an event-count-by-severity bucket.
 * Granularity: hourly.
 *
 * @param {string} severity - 'low' | 'medium' | 'high' | 'critical'
 * @param {Date}   [date]   - defaults to now
 * @returns {string}  e.g. "events_by_severity:high:2026-04-10T14"
 */
function severityKey(severity, date = new Date()) {
  return `events_by_severity:${severity}:${hourWindow(date)}`;
}

/**
 * Build the metricKey for an event-count-by-source bucket.
 * Granularity: daily.
 *
 * @param {string} source - 'api' | 'webhook' | 'manual'
 * @param {Date}   [date]
 * @returns {string}  e.g. "events_by_source:webhook:2026-04-10"
 */
function sourceKey(source, date = new Date()) {
  return `events_by_source:${source}:${dayWindow(date)}`;
}

/**
 * Build the metricKey for AI token usage.
 * Granularity: daily.
 *
 * @param {string} model - e.g. 'gpt-4o-mini'
 * @param {Date}   [date]
 * @returns {string}  e.g. "ai_tokens:gpt-4o-mini:2026-04-10"
 */
function aiTokenKey(model, date = new Date()) {
  return `ai_tokens:${model}:${dayWindow(date)}`;
}

/**
 * Build the metricKey for daily AI cost in USD.
 *
 * @param {Date} [date]
 * @returns {string}  e.g. "ai_cost:2026-04-10"
 */
function aiCostKey(date = new Date()) {
  return `ai_cost:${dayWindow(date)}`;
}

/**
 * Build the metricKey for per-channel alert counts.
 * Granularity: daily.
 *
 * @param {string} channel - 'email' | 'slack' | 'sms'
 * @param {Date}   [date]
 * @returns {string}  e.g. "alert_by_channel:email:2026-04-10"
 */
function alertChannelKey(channel, date = new Date()) {
  return `alert_by_channel:${channel}:${dayWindow(date)}`;
}

/**
 * Build the metricKey for Lambda function duration tracking.
 * Granularity: hourly.
 *
 * @param {string} functionName - Lambda function name
 * @param {Date}   [date]
 * @returns {string}  e.g. "lambda_duration:eventProcessor:2026-04-10T14"
 */
function lambdaDurationKey(functionName, date = new Date()) {
  return `lambda_duration:${functionName}:${hourWindow(date)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB MARSHALLING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a validated Metric object to DynamoDB low-level format.
 * Use with DynamoDBClient (not the document client).
 *
 * @param {object} metric - Output of validateMetric()
 * @returns {object} DynamoDB AttributeValue map
 */
function toItem(metric) {
  return marshall(metric, {
    removeUndefinedValues: true,
    convertEmptyValues:    false,
  });
}

/**
 * Convert a raw DynamoDB item back to a plain Metric object.
 *
 * @param {object} item - DynamoDB AttributeValue map
 * @returns {object|null}
 */
function fromItem(item) {
  if (!item) return null;
  return unmarshall(item);
}

/**
 * Serialise a metric for DynamoDBDocumentClient.
 * Strips undefined values that would cause SDK warnings.
 *
 * @param {object} metric
 * @returns {object}
 */
function toDocument(metric) {
  return stripUndefined(metric);
}

/**
 * Build an atomic increment UpdateExpression for a counter metric.
 * Initialises the counter to 0 if it doesn't exist yet (ADD semantics).
 *
 * @param {number} incrementBy - Amount to add (default 1)
 * @param {object} dimensions  - Dimension map to write/update
 * @param {number} ttl         - TTL epoch value
 * @returns {{ UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues }}
 *
 * @example
 * const expr = buildIncrementExpression(1, { severity: 'high' }, ttl);
 * await dynamoDoc.update({
 *   TableName: METRICS_TABLE,
 *   Key: { metricKey, timestamp },
 *   ...expr,
 * });
 */
function buildIncrementExpression(incrementBy = 1, dimensions = {}, ttl = null) {
  const names  = { '#value': 'value', '#unit': 'unit', '#dimensions': 'dimensions' };
  const values = {
    ':inc':        incrementBy,
    ':zero':       0,
    ':unit':       'Count',
    ':dimensions': dimensions,
  };

  let setClause = 'SET #unit = :unit, #dimensions = :dimensions';

  if (ttl !== null) {
    names['#ttl']  = 'ttl';
    values[':ttl'] = ttl;
    setClause     += ', #ttl = :ttl';
  }

  return {
    UpdateExpression:          `${setClause} ADD #value :inc`,
    ExpressionAttributeNames:  names,
    ExpressionAttributeValues: values,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Hourly window string: "2026-04-10T14" */
function hourWindow(date) {
  return date.toISOString().slice(0, 13);   // "YYYY-MM-DDTHH"
}

/** Daily window string: "2026-04-10" */
function dayWindow(date) {
  return date.toISOString().slice(0, 10);   // "YYYY-MM-DD"
}

function computeTtl(days) {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Schemas
  metricSchema,
  incrementSchema,

  // Validation
  validateMetric,
  validateIncrement,

  // Metric key builders
  severityKey,
  sourceKey,
  aiTokenKey,
  aiCostKey,
  alertChannelKey,
  lambdaDurationKey,

  // DynamoDB marshalling
  toItem,
  fromItem,
  toDocument,
  buildIncrementExpression,

  // Constants
  METRIC_UNITS,
  METRIC_CATEGORIES,
};
