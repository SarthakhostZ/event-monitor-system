'use strict';

const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const ALERT_CHANNELS = ['email', 'slack', 'sms'];
const ALERT_STATUSES = ['pending', 'sent', 'failed', 'retrying'];
const MAX_RETRY_COUNT = 3;
const ALERT_TTL_DAYS  = 90;   // keep alert records for 90 days

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema for creating a new Alert record.
 * Called by alertDispatcher when it begins dispatching for an event.
 */
const createAlertSchema = Joi.object({
  // ── Identity ──────────────────────────────────────────────────────────────
  alertId: Joi.string()
    .uuid({ version: 'uuidv4' })
    .default(() => uuidv4())
    .description('Unique alert identifier — auto-generated'),

  eventId: Joi.string()
    .uuid({ version: 'uuidv4' })
    .required()
    .description('Reference to the EventsTable record that triggered this alert'),

  // ── Routing ───────────────────────────────────────────────────────────────
  channel: Joi.string()
    .valid(...ALERT_CHANNELS)
    .required()
    .description('Delivery channel: email | slack | sms'),

  // One alert record is created per channel, so the list of channels
  // attempted for a single event is stored on the parent event record.
  channels: Joi.array()
    .items(Joi.string().valid(...ALERT_CHANNELS))
    .min(1)
    .optional()
    .description('All channels attempted for this event (denormalised for dashboard queries)'),

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  status: Joi.string()
    .valid(...ALERT_STATUSES)
    .default('pending')
    .description('Delivery status: pending → sent | failed; failed → retrying → sent | failed'),

  sentAt: Joi.string()
    .isoDate()
    .optional()
    .description('ISO timestamp of successful delivery'),

  failedAt: Joi.string()
    .isoDate()
    .optional()
    .description('ISO timestamp of most recent delivery failure'),

  timestamp: Joi.string()
    .isoDate()
    .default(() => new Date().toISOString())
    .description('Alert record creation time (DynamoDB sort key)'),

  retryCount: Joi.number()
    .integer()
    .min(0)
    .max(MAX_RETRY_COUNT)
    .default(0)
    .description(`Number of send attempts so far; capped at ${MAX_RETRY_COUNT}`),

  nextRetryAt: Joi.string()
    .isoDate()
    .optional()
    .description('ISO timestamp of scheduled next retry (exponential backoff)'),

  ttl: Joi.number()
    .integer()
    .positive()
    .optional()
    .description('Unix epoch expiry — auto-computed to 90 days from now'),

  // ── Delivery response ─────────────────────────────────────────────────────
  response: Joi.object({
    statusCode: Joi.number().integer().optional(),
    messageId:  Joi.string().max(256).optional(),   // SES message ID, Slack ts, etc.
    body:       Joi.string().max(2000).optional(),  // truncated raw response
    error:      Joi.string().max(2000).optional(),  // error message on failure
  })
    .optional()
    .description('Raw delivery response from the downstream channel'),

  // ── Payload snapshot (for audit / replay) ─────────────────────────────────
  payload: Joi.object({
    subject:        Joi.string().max(200).optional(),
    recipientEmail: Joi.string().email().optional(),
    slackChannel:   Joi.string().max(100).optional(),
    phoneNumber:    Joi.string().max(20).optional(),
    bodyPreview:    Joi.string().max(500).optional(),  // first 500 chars of rendered body
  })
    .optional()
    .description('Snapshot of what was sent — useful for audit and replay'),
});

/**
 * Schema for updating an existing alert (status transitions, retry bookkeeping).
 * All fields are optional — only changed fields need to be supplied.
 */
const updateAlertSchema = Joi.object({
  status:      Joi.string().valid(...ALERT_STATUSES),
  sentAt:      Joi.string().isoDate(),
  failedAt:    Joi.string().isoDate(),
  retryCount:  Joi.number().integer().min(0).max(MAX_RETRY_COUNT),
  nextRetryAt: Joi.string().isoDate(),
  response:    Joi.object({
    statusCode: Joi.number().integer(),
    messageId:  Joi.string().max(256),
    body:       Joi.string().max(2000),
    error:      Joi.string().max(2000),
  }),
}).min(1);

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalise an inbound alert creation payload.
 * Applies Joi defaults (alertId, timestamp, status='pending') and
 * computes the DynamoDB TTL epoch if not present.
 *
 * @param {object} data - Raw alert data from alertDispatcher
 * @returns {{ value: object, error: Joi.ValidationError|undefined }}
 *
 * @example
 * const { value, error } = validateAlert({ eventId: 'uuid...', channel: 'email' });
 * if (error) throw new Error(error.message);
 * await dynamoDoc.put({ TableName: ALERTS_TABLE, Item: toDocument(value) });
 */
function validateAlert(data) {
  const { value, error } = createAlertSchema.validate(data, {
    abortEarly:   false,
    stripUnknown: true,
    convert:      true,
  });

  if (error) return { value: null, error };

  if (!value.ttl) {
    value.ttl = computeTtl(ALERT_TTL_DAYS);
  }

  return { value, error: undefined };
}

/**
 * Validate a partial alert update (status transitions, retry writes).
 *
 * @param {object} data - Fields to update
 * @returns {{ value: object, error: Joi.ValidationError|undefined }}
 */
function validateAlertUpdate(data) {
  return updateAlertSchema.validate(data, {
    abortEarly:   false,
    stripUnknown: true,
    convert:      true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a complete, validated Alert record ready for DynamoDB insertion.
 * Throws a descriptive Error if validation fails.
 *
 * @param {object} rawInput
 * @returns {object}
 */
function createAlert(rawInput) {
  const { value, error } = validateAlert(rawInput);
  if (error) {
    const messages = error.details.map((d) => d.message).join('; ');
    throw new Error(`Alert validation failed: ${messages}`);
  }
  return value;
}

/**
 * Compute the ISO timestamp for the next retry using exponential backoff.
 *
 * Delays: attempt 0 → 30s, attempt 1 → 60s, attempt 2 → 120s.
 *
 * @param {number} retryCount - Current retry count (0-based)
 * @returns {string} ISO timestamp for the next retry
 */
function computeNextRetryAt(retryCount) {
  const delaySeconds = 30 * Math.pow(2, retryCount);   // 30s, 60s, 120s
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

/**
 * Returns true if the alert is eligible for another retry attempt.
 *
 * @param {object} alert - Validated alert object
 * @returns {boolean}
 */
function canRetry(alert) {
  return alert.retryCount < MAX_RETRY_COUNT && alert.status === 'failed';
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB MARSHALLING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a validated Alert object to DynamoDB low-level format.
 * Use with DynamoDBClient (not the document client).
 *
 * @param {object} alert - Output of validateAlert() or createAlert()
 * @returns {object} DynamoDB AttributeValue map
 */
function toItem(alert) {
  return marshall(alert, {
    removeUndefinedValues: true,
    convertEmptyValues:    false,
  });
}

/**
 * Convert a raw DynamoDB item back to a plain Alert object.
 * Use with DynamoDBClient responses.
 *
 * @param {object} item - DynamoDB AttributeValue map
 * @returns {object|null}
 */
function fromItem(item) {
  if (!item) return null;
  return unmarshall(item);
}

/**
 * Serialise an alert for DynamoDBDocumentClient (high-level SDK).
 * Strips undefined values that would cause SDK warnings.
 *
 * @param {object} alert
 * @returns {object}
 */
function toDocument(alert) {
  return stripUndefined(alert);
}

/**
 * Build a DynamoDB UpdateExpression from a partial update object.
 *
 * @param {object} updates - Output of validateAlertUpdate()
 * @returns {{ UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues }}
 */
function buildUpdateExpression(updates) {
  const names  = {};
  const values = {};
  const parts  = [];

  for (const [key, val] of Object.entries(updates)) {
    // Nested objects (e.g. response) are stored as a single attribute
    const nameKey  = `#${key}`;
    const valueKey = `:${key}`;
    names[nameKey]  = key;
    values[valueKey] = val;
    parts.push(`${nameKey} = ${valueKey}`);
  }

  return {
    UpdateExpression:          `SET ${parts.join(', ')}`,
    ExpressionAttributeNames:  names,
    ExpressionAttributeValues: values,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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
  createAlertSchema,
  updateAlertSchema,

  // Validation
  validateAlert,
  validateAlertUpdate,

  // Factory
  createAlert,

  // Business logic helpers
  computeNextRetryAt,
  canRetry,

  // DynamoDB marshalling
  toItem,
  fromItem,
  toDocument,
  buildUpdateExpression,

  // Constants
  ALERT_CHANNELS,
  ALERT_STATUSES,
  MAX_RETRY_COUNT,
};
