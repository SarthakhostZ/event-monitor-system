'use strict';

const Joi = require('joi');
const { v4: uuidv4 } = require('uuid');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_SOURCES   = ['api', 'webhook', 'manual'];
const EVENT_TYPES     = ['error', 'warning', 'info', 'critical'];
const SEVERITIES      = ['low', 'medium', 'high', 'critical'];
const EVENT_STATUSES  = ['new', 'processing', 'analyzed', 'alerted'];
const TTL_DAYS        = parseInt(process.env.EVENT_TTL_DAYS, 10) || 30;

// ─────────────────────────────────────────────────────────────────────────────
// SCHEMA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema used when an external caller submits a new event (POST /events).
 * Auto-generated fields (eventId, timestamp, ttl, status) are optional here —
 * createEvent() will supply defaults before writing to DynamoDB.
 */
const ingestSchema = Joi.object({
  // ── Identity ──────────────────────────────────────────────────────────────
  eventId: Joi.string()
    .uuid({ version: 'uuidv4' })
    .default(() => uuidv4())
    .description('Unique event identifier — auto-generated if not provided'),

  idempotencyKey: Joi.string()
    .max(128)
    .optional()
    .description('Caller-supplied deduplication key; auto-derived from hash if omitted'),

  // ── Classification ────────────────────────────────────────────────────────
  source: Joi.string()
    .valid(...EVENT_SOURCES)
    .required()
    .description('Origin of the event: api | webhook | manual'),

  type: Joi.string()
    .valid(...EVENT_TYPES)
    .required()
    .description('Event category: error | warning | info | critical'),

  severity: Joi.string()
    .valid(...SEVERITIES)
    .default('medium')
    .description('Initial severity before rule engine / AI analysis'),

  // ── Content ───────────────────────────────────────────────────────────────
  title: Joi.string()
    .min(1)
    .max(200)
    .required()
    .description('Short human-readable event title'),

  description: Joi.string()
    .max(2000)
    .allow('')
    .default('')
    .description('Detailed event description'),

  metadata: Joi.object()
    .pattern(
      Joi.string().max(64),                   // key constraint
      Joi.alternatives().try(                 // value constraint
        Joi.string().max(1024),
        Joi.number(),
        Joi.boolean(),
        Joi.array().items(Joi.string(), Joi.number()).max(50),
      ),
    )
    .default({})
    .description('Flexible key-value bag for source-specific context'),

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  timestamp: Joi.string()
    .isoDate()
    .default(() => new Date().toISOString())
    .description('Event creation time — auto-set to now if not provided'),

  status: Joi.string()
    .valid(...EVENT_STATUSES)
    .default('new')
    .description('Processing lifecycle status'),

  ttl: Joi.number()
    .integer()
    .positive()
    .optional()
    .description('Unix epoch expiry time — auto-computed from EVENT_TTL_DAYS'),

  // ── AI fields (read-only from the caller's perspective) ───────────────────
  aiSummary: Joi.string()
    .max(2000)
    .optional()
    .description('AI-generated plain-English summary'),

  aiSeverity: Joi.string()
    .valid(...SEVERITIES)
    .optional()
    .description('AI-predicted severity classification'),

  aiRecommendation: Joi.string()
    .max(2000)
    .optional()
    .description('AI-suggested remediation action'),

  aiRootCause: Joi.string()
    .max(2000)
    .optional()
    .description('AI-inferred root cause'),

  aiConfidence: Joi.number()
    .min(0)
    .max(100)
    .optional()
    .description('AI confidence score (0–100); below 50 falls back to rule engine'),
});

/**
 * Schema used when updating an existing event (e.g. after AI analysis).
 * All fields are optional — only changed fields need to be supplied.
 */
const updateSchema = Joi.object({
  status:           Joi.string().valid(...EVENT_STATUSES),
  severity:         Joi.string().valid(...SEVERITIES),
  aiSummary:        Joi.string().max(2000),
  aiSeverity:       Joi.string().valid(...SEVERITIES),
  aiRecommendation: Joi.string().max(2000),
  aiRootCause:      Joi.string().max(2000),
  aiConfidence:     Joi.number().min(0).max(100),
}).min(1);   // at least one field must be present

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate and normalise an inbound event payload.
 *
 * Applies Joi defaults (eventId UUID, timestamp, status='new') and computes
 * the DynamoDB TTL epoch if not already present.
 *
 * @param {object} data - Raw input from the API handler or SQS message body
 * @returns {{ value: object, error: Joi.ValidationError|undefined }}
 *
 * @example
 * const { value, error } = validateEvent({ source: 'api', type: 'error', title: 'Oops' });
 * if (error) throw new ValidationError(error.message);
 * const item = toItem(value);
 */
function validateEvent(data) {
  const { value, error } = ingestSchema.validate(data, {
    abortEarly: false,       // collect all errors, not just first
    stripUnknown: true,      // drop unrecognised keys silently
    convert: true,           // coerce types (string dates → ISO, etc.)
  });

  if (error) return { value: null, error };

  // Compute TTL if not explicitly supplied
  if (!value.ttl) {
    value.ttl = computeTtl(TTL_DAYS);
  }

  // Derive idempotencyKey from eventId if caller didn't supply one
  if (!value.idempotencyKey) {
    value.idempotencyKey = value.eventId;
  }

  return { value, error: undefined };
}

/**
 * Validate a partial update payload (status transitions, AI field writes).
 *
 * @param {object} data - Fields to update
 * @returns {{ value: object, error: Joi.ValidationError|undefined }}
 */
function validateEventUpdate(data) {
  return updateSchema.validate(data, {
    abortEarly: false,
    stripUnknown: true,
    convert: true,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a complete, validated Event ready for DynamoDB insertion.
 * Throws a descriptive Error if validation fails.
 *
 * @param {object} rawInput
 * @returns {object} Validated event with all defaults applied
 */
function createEvent(rawInput) {
  const { value, error } = validateEvent(rawInput);
  if (error) {
    const messages = error.details.map((d) => d.message).join('; ');
    throw new Error(`Event validation failed: ${messages}`);
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB MARSHALLING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a validated Event object into a DynamoDB item (low-level format).
 * Use this when calling DynamoDBClient directly.
 *
 * @param {object} event - Output of validateEvent() or createEvent()
 * @returns {object} DynamoDB AttributeValue map  { eventId: { S: '...' }, ... }
 *
 * @example
 * await dynamoClient.send(new PutItemCommand({
 *   TableName: EVENTS_TABLE,
 *   Item: toItem(event),
 *   ConditionExpression: 'attribute_not_exists(idempotencyKey)',
 * }));
 */
function toItem(event) {
  return marshall(event, {
    removeUndefinedValues: true,   // don't write NULL placeholders for optional fields
    convertEmptyValues: false,     // keep empty strings as-is
  });
}

/**
 * Convert a raw DynamoDB item (low-level format) back into a plain Event object.
 * Use this when reading from DynamoDBClient directly.
 *
 * @param {object} item - DynamoDB AttributeValue map from GetItem / Query response
 * @returns {object} Plain JS Event object
 */
function fromItem(item) {
  if (!item) return null;
  return unmarshall(item);
}

/**
 * Serialise an event for the DynamoDBDocumentClient (high-level SDK).
 * The document client does its own marshalling, so this just strips
 * undefined fields that would cause SDK warnings.
 *
 * @param {object} event
 * @returns {object}
 */
function toDocument(event) {
  return stripUndefined(event);
}

/**
 * Build a DynamoDB UpdateExpression from a partial update object.
 * Returns the expression string, ExpressionAttributeNames, and
 * ExpressionAttributeValues ready to pass to UpdateItemCommand.
 *
 * @param {object} updates - Output of validateEventUpdate()
 * @returns {{ UpdateExpression: string, ExpressionAttributeNames: object, ExpressionAttributeValues: object }}
 *
 * @example
 * const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues }
 *   = buildUpdateExpression({ status: 'analyzed', aiSeverity: 'high' });
 */
function buildUpdateExpression(updates) {
  const names  = {};
  const values = {};
  const parts  = [];

  for (const [key, val] of Object.entries(updates)) {
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

/** Compute a Unix epoch TTL N days from now. */
function computeTtl(days) {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

/** Remove keys with undefined values from an object (shallow). */
function stripUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Schemas (expose for handler-level or middleware re-use)
  ingestSchema,
  updateSchema,

  // Validation
  validateEvent,
  validateEventUpdate,

  // Factory
  createEvent,

  // DynamoDB marshalling
  toItem,
  fromItem,
  toDocument,
  buildUpdateExpression,

  // Constants (re-exported so handlers don't hard-code strings)
  EVENT_SOURCES,
  EVENT_TYPES,
  SEVERITIES,
  EVENT_STATUSES,
};
