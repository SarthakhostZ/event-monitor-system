'use strict';

/**
 * alertDispatcher — Lambda handler triggered by SNS "CriticalAlerts" topic
 *
 * Trigger:  SNS topic (one SNS record per Lambda invocation in practice,
 *           but the handler iterates all Records for correctness).
 *
 * Flow per SNS record:
 *   parse message → dedup check (5-min window, DynamoDB conditional write)
 *     → determine channels from severity
 *       → dispatch to each channel (email now; Slack/SMS stubs for future)
 *         → save alert record per channel in AlertsTable
 *           → retry failed channels (max 3, exponential backoff)
 *             → mark exhausted channels as failed; throw to allow SNS retry
 *
 * Channel routing:
 *   critical  → email + slack + sms
 *   high      → email + slack
 *   medium    → email
 *   low       → (none — analyzer should never publish low events to SNS)
 *
 * De-duplication:
 *   A dedup sentinel item is conditionally written to AlertsTable with
 *   PK = "dedup_<eventId>" and TTL = now + 300 s.  If the item already exists,
 *   the alert was recently dispatched and this invocation is skipped silently.
 *   The 5-minute TTL is enforced by DynamoDB's native TTL mechanism.
 *
 * Retry strategy:
 *   Transient send failures are retried inline (up to MAX_RETRIES times) with
 *   exponential backoff (1 s → 2 s → 4 s).  This handles short network blips
 *   within the Lambda invocation window.
 *   If all retries are exhausted, the alert record is marked "failed" and the
 *   error is rethrown so SNS can perform its own retry (with longer delays) and
 *   ultimately deliver the message to the configured DLQ.
 *
 * Error handling:
 *   Per-channel failures are isolated: a Slack failure does not prevent the
 *   email from being sent.  If ANY channel exhausts retries the handler throws
 *   at the end so SNS can re-deliver.  Idempotent dedup guards prevent
 *   double-sending on SNS retry.
 */

const { DynamoDBClient }  = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 }      = require('uuid');

const logger              = require('../utils/logger');
const { sendAlertEmail }  = require('../services/emailService');
const {
  createAlert,
  computeNextRetryAt,
  MAX_RETRY_COUNT,
} = require('../models/alertModel');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start)
// ─────────────────────────────────────────────────────────────────────────────
const REGION        = process.env.AWS_REGION           || 'ap-south-1';
const ALERTS_TABLE  = process.env.DYNAMODB_ALERTS_TABLE;
const ALERT_TTL_DAYS = 90;

/** Channels to attempt per severity level. */
const SEVERITY_CHANNELS = {
  critical: ['email', 'slack', 'sms'],
  high:     ['email', 'slack'],
  medium:   ['email'],
  low:      [],
};

/** De-duplication window in seconds (5 minutes). */
const DEDUP_WINDOW_SECS = 5 * 60;

/** Max inline retries per channel before marking failed. */
const MAX_INLINE_RETRIES = MAX_RETRY_COUNT;   // 3

/** Base delay (ms) for exponential backoff: 1 s → 2 s → 4 s. */
const RETRY_BASE_MS = 1_000;

// ─────────────────────────────────────────────────────────────────────────────
// AWS CLIENTS  (reused across warm invocations)
// ─────────────────────────────────────────────────────────────────────────────
const dynamoOpts = {
  region: REGION,
  ...(process.env.DYNAMODB_ENDPOINT && { endpoint: process.env.DYNAMODB_ENDPOINT }),
};

const _dynamoClient = new DynamoDBClient(dynamoOpts);
const docClient     = DynamoDBDocumentClient.from(_dynamoClient, {
  marshallOptions: { removeUndefinedValues: true },
});

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SNS batch handler.
 *
 * @param {object}   snsEvent
 * @param {object[]} snsEvent.Records
 */
exports.handler = async (snsEvent) => {
  const invocationId = uuidv4();
  const batchSize    = snsEvent.Records.length;

  const log = logger.child({ fn: 'alertDispatcher', invocationId, batchSize });
  log.info('SNS batch received');

  const outcomes = await Promise.allSettled(
    snsEvent.Records.map((record) => processRecord(record, log)),
  );

  let dispatched = 0;
  let deduped    = 0;
  let failed     = 0;

  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      failed++;
      log.error('Record processing failed', {
        recordIndex: i,
        error:       outcome.reason?.message,
        stack:       outcome.reason?.stack,
      });
    } else if (outcome.value?.skipped) {
      deduped++;
    } else {
      dispatched++;
    }
  });

  log.info('Batch complete', { batchSize, dispatched, deduped, failed });

  // Re-throw if any record failed — allows SNS to retry the delivery and
  // ultimately route to the configured DLQ.
  if (failed > 0) {
    throw new Error(
      `alertDispatcher: ${failed} of ${batchSize} records failed — retrying`,
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RECORD PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single SNS record.
 *
 * @param {object} record    - Single SNS record from the Lambda event
 * @param {object} parentLog - Parent Winston logger
 * @returns {Promise<{ skipped: boolean }>}
 */
async function processRecord(record, parentLog) {
  // ── Step 1: Parse SNS message ─────────────────────────────────────────────
  let eventData;
  try {
    eventData = JSON.parse(record.Sns.Message);
  } catch (err) {
    parentLog.error('Failed to parse SNS message body', {
      error:   err.message,
      message: record.Sns?.Message?.slice(0, 200),
    });
    throw new Error(`SNS message parse error: ${err.message}`);
  }

  const log = parentLog.child({
    eventId:  eventData.eventId,
    severity: eventData.severity,
    source:   eventData.source,
  });

  log.info('Processing SNS alert record', { title: eventData.title });

  // ── Step 2: Determine channels ────────────────────────────────────────────
  const channels = SEVERITY_CHANNELS[eventData.severity] ?? [];

  if (channels.length === 0) {
    log.info('No channels configured for severity — skipping', {
      severity: eventData.severity,
    });
    return { skipped: true };
  }

  // ── Step 3: De-duplication check ──────────────────────────────────────────
  const isDuplicate = await checkDedup(eventData.eventId, log);
  if (isDuplicate) {
    log.info('De-dup hit — alert already dispatched within the last 5 minutes', {
      eventId: eventData.eventId,
    });
    return { skipped: true };
  }

  // ── Step 4: Dispatch to each channel ──────────────────────────────────────
  const allChannelsFailed = [];

  await Promise.allSettled(
    channels.map(async (channel) => {
      const channelLog = log.child({ channel });
      const result     = await dispatchWithRetry(channel, eventData, channels, channelLog);
      if (result.failed) {
        allChannelsFailed.push(channel);
      }
    }),
  );

  if (allChannelsFailed.length > 0) {
    // Some channels exhausted all retries.  Throw to allow SNS to re-deliver.
    throw new Error(
      `alertDispatcher: channels [${allChannelsFailed.join(', ')}] exhausted retries for event ${eventData.eventId}`,
    );
  }

  log.info('All channels dispatched successfully', { channels, eventId: eventData.eventId });
  return { skipped: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEDUPLICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a dedup sentinel to AlertsTable.
 * Returns true if a sentinel already exists (= duplicate within 5-min window).
 * Returns false if the sentinel was freshly written (= first dispatch).
 *
 * DynamoDB TTL handles expiry — the 5-minute window is approximate.
 *
 * @param {string} eventId
 * @param {object} log
 * @returns {Promise<boolean>}  true = duplicate, false = first occurrence
 */
async function checkDedup(eventId, log) {
  const dedupTtl = Math.floor(Date.now() / 1000) + DEDUP_WINDOW_SECS;

  try {
    await docClient.send(new PutCommand({
      TableName: ALERTS_TABLE,
      Item: {
        alertId:   `dedup_${eventId}`,
        timestamp: 'dedup',
        eventId,
        ttl:       dedupTtl,
      },
      ConditionExpression: 'attribute_not_exists(alertId)',
    }));

    // Sentinel written successfully — this is the first dispatch.
    return false;

  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      return true;   // Sentinel already exists — duplicate.
    }
    // Unexpected DynamoDB error — log and proceed (fail open to avoid missed alerts).
    log.warn('Dedup check failed — proceeding without dedup guard', {
      error: err.message,
      code:  err.name,
      eventId,
    });
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL DISPATCH WITH RETRY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to dispatch an alert over a single channel, with up to
 * MAX_INLINE_RETRIES retries and exponential backoff.
 *
 * An AlertsTable record is created before the first attempt and updated on
 * each outcome (success / retry / final failure).
 *
 * @param {string}   channel
 * @param {object}   eventData
 * @param {string[]} allChannels - All channels being attempted (for denorm)
 * @param {object}   log
 * @returns {Promise<{ failed: boolean }>}
 */
async function dispatchWithRetry(channel, eventData, allChannels, log) {
  // Create the initial AlertsTable record (status = "pending").
  const alertRecord = createAlert({
    eventId:  eventData.eventId,
    channel,
    channels: allChannels,
    payload: buildPayloadSnapshot(channel, eventData),
  });

  await saveAlertRecord(alertRecord, log);

  let lastError = null;

  for (let attempt = 0; attempt <= MAX_INLINE_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s
      const delayMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      log.debug('Retrying after backoff', { attempt, delayMs, channel });
      await sleep(delayMs);

      await updateAlertRecord(alertRecord.alertId, alertRecord.timestamp, {
        status:      'retrying',
        retryCount:  attempt,
        nextRetryAt: computeNextRetryAt(attempt),
      }, log);
    }

    try {
      const sendResult = await sendToChannel(channel, eventData, log);

      // ── Success ────────────────────────────────────────────────────────────
      const now = new Date().toISOString();
      await updateAlertRecord(alertRecord.alertId, alertRecord.timestamp, {
        status:  'sent',
        sentAt:  now,
        retryCount: attempt,
        response: {
          messageId:  sendResult?.messageId ?? null,
          statusCode: 200,
        },
      }, log);

      log.info('Channel dispatch succeeded', {
        channel,
        attempt,
        messageId: sendResult?.messageId,
      });

      return { failed: false };

    } catch (err) {
      lastError = err;
      log.warn('Channel dispatch attempt failed', {
        channel,
        attempt,
        error:    err.message,
        willRetry: attempt < MAX_INLINE_RETRIES,
      });
    }
  }

  // ── All retries exhausted ─────────────────────────────────────────────────
  const failedAt = new Date().toISOString();
  await updateAlertRecord(alertRecord.alertId, alertRecord.timestamp, {
    status:     'failed',
    failedAt,
    retryCount: MAX_INLINE_RETRIES,
    response: {
      error: lastError?.message?.slice(0, 2000) ?? 'Unknown error',
    },
  }, log);

  log.error('Channel exhausted all retries — marking failed', {
    channel,
    maxRetries: MAX_INLINE_RETRIES,
    error:      lastError?.message,
  });

  return { failed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL SENDERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch to the correct send function for a given channel.
 *
 * @param {string} channel    - "email" | "slack" | "sms"
 * @param {object} eventData
 * @param {object} log
 * @returns {Promise<object>}  Channel-specific result object
 * @throws When the send fails (caller handles retry)
 */
async function sendToChannel(channel, eventData, log) {
  switch (channel) {
    case 'email':
      return sendEmail(eventData, log);

    case 'slack':
      return sendSlack(eventData, log);

    case 'sms':
      return sendSms(eventData, log);

    default:
      throw new Error(`Unknown alert channel: ${channel}`);
  }
}

/**
 * Send an email alert via emailService.
 *
 * @param {object} eventData
 * @param {object} log
 * @returns {Promise<{ messageId: string|null }>}
 * @throws When SMTP send fails (email is configured but delivery fails)
 */
async function sendEmail(eventData, log) {
  log.debug('Sending email alert');
  const result = await sendAlertEmail(eventData);

  if (result?.skipped) {
    // SMTP not configured — treat as a no-op success (warn was already logged).
    log.warn('Email alert skipped — SMTP not configured', { eventId: eventData.eventId });
    return { messageId: null };
  }

  return { messageId: result.messageId };
}

/**
 * Slack stub — logs intent; implement when Slack webhook is available.
 *
 * @param {object} eventData
 * @param {object} log
 * @returns {Promise<{ messageId: null }>}
 */
async function sendSlack(eventData, log) {
  // TODO: implement Slack webhook POST
  // 1. Build Slack Block Kit message payload with severity colour and AI summary.
  // 2. POST to process.env.SLACK_WEBHOOK_URL using fetch / axios.
  // 3. Return { messageId: response.ts } on success.
  log.info('Slack dispatch (stub) — not yet implemented', {
    eventId:  eventData.eventId,
    severity: eventData.severity,
  });
  return { messageId: null };
}

/**
 * SMS stub — logs intent; implement when SNS SMS or Twilio is available.
 *
 * @param {object} eventData
 * @param {object} log
 * @returns {Promise<{ messageId: null }>}
 */
async function sendSms(eventData, log) {
  // TODO: implement SMS via AWS SNS SMS or Twilio
  // 1. Compose a short text: "[CRITICAL] <title> — Event <eventId>".
  // 2. Publish to SNS SMS endpoint or call Twilio Messages API.
  // 3. Return { messageId: snsMessageId } on success.
  log.info('SMS dispatch (stub) — not yet implemented', {
    eventId:  eventData.eventId,
    severity: eventData.severity,
  });
  return { messageId: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB — ALERT RECORD OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the initial alert record to AlertsTable.
 *
 * @param {object} alertRecord - Output of createAlert()
 * @param {object} log
 */
async function saveAlertRecord(alertRecord, log) {
  try {
    await docClient.send(new PutCommand({
      TableName: ALERTS_TABLE,
      Item:      alertRecord,
      // Guard against accidental double-write (SNS retry after a partial batch).
      ConditionExpression: 'attribute_not_exists(alertId)',
    }));
    log.debug('Alert record created in AlertsTable', { alertId: alertRecord.alertId });
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      // Record already exists (SNS retry) — safe to proceed.
      log.debug('Alert record already exists — continuing (SNS retry?)', {
        alertId: alertRecord.alertId,
      });
      return;
    }
    log.error('Failed to create alert record', { error: err.message, code: err.name });
    throw err;
  }
}

/**
 * Patch an alert record in AlertsTable (status, sentAt, retryCount, etc.).
 *
 * @param {string} alertId
 * @param {string} timestamp     - Sort key of the record
 * @param {object} updates       - Plain object of fields to SET
 * @param {object} log
 */
async function updateAlertRecord(alertId, timestamp, updates, log) {
  const names  = {};
  const values = {};
  const parts  = [];

  for (const [key, val] of Object.entries(updates)) {
    names[`#${key}`]  = key;
    values[`:${key}`] = val;
    parts.push(`#${key} = :${key}`);
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName:                 ALERTS_TABLE,
      Key:                       { alertId, timestamp },
      UpdateExpression:          `SET ${parts.join(', ')}`,
      ExpressionAttributeNames:  names,
      ExpressionAttributeValues: values,
    }));
    log.debug('Alert record updated', { alertId, updates: Object.keys(updates) });
  } catch (err) {
    // Log but do not throw — a bookkeeping failure should not abort the dispatch.
    log.warn('Failed to update alert record', {
      alertId,
      error: err.message,
      code:  err.name,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a lightweight payload snapshot for the AlertsTable audit record.
 *
 * @param {string} channel
 * @param {object} eventData
 * @returns {object}
 */
function buildPayloadSnapshot(channel, eventData) {
  const base = {
    bodyPreview: eventData.aiSummary
      ? eventData.aiSummary.slice(0, 500)
      : (eventData.description || '').slice(0, 500),
  };

  switch (channel) {
    case 'email':
      return {
        ...base,
        subject:        `[${(eventData.severity || 'ALERT').toUpperCase()}] ${eventData.title || 'Event Alert'}`,
        recipientEmail: process.env.ALERT_EMAIL_TO || null,
      };
    case 'slack':
      return {
        ...base,
        slackChannel: process.env.SLACK_CHANNEL || '#alerts',
      };
    case 'sms':
      return {
        ...base,
        phoneNumber: process.env.ALERT_SMS_TO || null,
      };
    default:
      return base;
  }
}

/**
 * Return a Promise that resolves after `ms` milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
