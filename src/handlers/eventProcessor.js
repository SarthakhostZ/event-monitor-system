'use strict';

/**
 * eventProcessor — Lambda handler triggered by SQS EventProcessingQueue
 *
 * Flow per SQS message:
 *   parse body → rule-engine classification → conditional DynamoDB write
 *     → metric counter increments → log outcome
 *
 * Partial batch failure handling
 * ───────────────────────────────
 * Messages are processed independently.  A failure in one record adds its
 * messageId to `batchItemFailures` and SQS retries only that message.
 * The successfully processed records are NOT redelivered.
 *
 * Idempotency
 * ────────────
 * dynamoService.saveEvent() uses a conditional write (`attribute_not_exists(eventId)`)
 * so SQS redeliveries of already-saved events are silently skipped — they are
 * never added to batchItemFailures because retrying a duplicate is pointless.
 *
 * Concurrency
 * ────────────
 * All records in a batch are processed in parallel (Promise.allSettled).
 * Each invocation is isolated by eventId so there is no shared mutable state.
 */

const { v4: uuidv4 }             = require('uuid');
const logger                     = require('../utils/logger');
const { applyRules }             = require('../services/ruleEngine');
const { saveEvent, incrementEventMetrics } = require('../services/dynamoService');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start)
// ─────────────────────────────────────────────────────────────────────────────
const EVENT_TTL_DAYS = parseInt(process.env.EVENT_TTL_DAYS, 10) || 30;

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SQS batch event handler.
 *
 * @param {object} sqsEvent - AWS Lambda SQS event payload
 * @param {object[]} sqsEvent.Records - Up to 10 SQS messages
 * @returns {{ batchItemFailures: Array<{ itemIdentifier: string }> }}
 */
exports.handler = async (sqsEvent) => {
  const batchStartMs  = Date.now();
  const batchSize     = sqsEvent.Records.length;
  const invocationId  = uuidv4();   // ties all log lines for this invocation together

  const log = logger.child({ fn: 'eventProcessor', invocationId, batchSize });
  log.info('SQS batch received');

  // Process every record concurrently; collect per-record outcomes.
  const outcomes = await Promise.allSettled(
    sqsEvent.Records.map((record) => processRecord(record, log)),
  );

  // Tally results and build the SQS partial-failure response.
  const batchItemFailures = [];
  let processed = 0;
  let skipped   = 0;
  let failed    = 0;

  outcomes.forEach((outcome, i) => {
    const messageId = sqsEvent.Records[i].messageId;

    if (outcome.status === 'rejected') {
      failed++;
      batchItemFailures.push({ itemIdentifier: messageId });
      log.error('Record failed — will be retried by SQS', {
        messageId,
        error: outcome.reason?.message,
      });
    } else if (outcome.value?.skipped) {
      skipped++;
    } else {
      processed++;
    }
  });

  log.info('Batch processing complete', {
    batchSize,
    processed,
    skipped,
    failed,
    durationMs: Date.now() - batchStartMs,
  });

  return { batchItemFailures };
};

// ─────────────────────────────────────────────────────────────────────────────
// RECORD PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single SQS record end-to-end.
 *
 * Returns `{ skipped: true }` when the event is a duplicate (already in
 * DynamoDB).  Returns `{ skipped: false }` on successful write.
 * Throws on any unrecoverable error so the caller can mark the messageId
 * as a batchItemFailure for SQS retry.
 *
 * @param {object} record - Single SQS record from sqsEvent.Records
 * @param {object} parentLog - Parent Winston logger (already has invocationId)
 * @returns {Promise<{ skipped: boolean }>}
 */
async function processRecord(record, parentLog) {
  const { messageId, body } = record;
  const recordStartMs = Date.now();

  // ── Step 1: Parse the SQS message body ────────────────────────────────────
  let rawEvent;
  try {
    rawEvent = JSON.parse(body);
  } catch (parseErr) {
    // Malformed JSON cannot be fixed by retrying — log and rethrow so the
    // message eventually lands in the DLQ for manual inspection.
    parentLog.error('Invalid JSON in SQS message body', {
      messageId,
      error: parseErr.message,
    });
    throw parseErr;
  }

  // Strip _meta envelope added by eventIngest (not part of the domain model).
  const { _meta, ...eventData } = rawEvent;

  const log = parentLog.child({
    messageId,
    eventId: eventData.eventId,
    requestId: _meta?.requestId,
  });

  log.debug('SQS message parsed', {
    source:   eventData.source,
    type:     eventData.type,
    severity: eventData.severity,
  });

  // ── Step 2: Rule-engine classification ────────────────────────────────────
  const classification = applyRules(eventData);

  log.debug('Rule engine result', {
    incomingSeverity: eventData.severity,
    classifiedSeverity: classification.severity,
    matchedRuleId:    classification.matchedRuleId,
    triggerAlert:     classification.triggerAlert,
  });

  // ── Step 3: Build the final event record ───────────────────────────────────
  const now = new Date();

  const event = {
    ...eventData,
    // Rule-engine may promote or demote severity.
    severity:    classification.severity,
    // Status is set to "processing" here; eventAnalyzer will move it to "analyzed".
    status:      'processing',
    // Ensure TTL is always set — eventIngest may have already computed it,
    // but guard against missing values from any other ingestion path.
    ttl:         eventData.ttl || computeTtl(EVENT_TTL_DAYS),
    processedAt: now.toISOString(),
    // Carry forward rule classification metadata for downstream consumers.
    ruleId:      classification.matchedRuleId,
    triggerAlert: classification.triggerAlert,
  };

  // ── Step 4: Conditional write to EventsTable ──────────────────────────────
  const saved = await saveEvent(event);

  if (!saved) {
    // Duplicate detected by conditional write — already processed.
    log.warn('Duplicate event skipped', { eventId: event.eventId });
    return { skipped: true };
  }

  // ── Step 5: Increment MetricsTable counters ────────────────────────────────
  // Best-effort: a metric failure is logged inside incrementEventMetrics but
  // does not throw, so it never causes this message to be retried via DLQ.
  await incrementEventMetrics(event);

  const durationMs = Date.now() - recordStartMs;
  log.info('Event processed and stored', {
    severity:     event.severity,
    source:       event.source,
    type:         event.type,
    triggerAlert: event.triggerAlert,
    matchedRuleId: event.ruleId,
    durationMs,
  });

  return { skipped: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Compute a Unix epoch TTL N days from now. */
function computeTtl(days) {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}
