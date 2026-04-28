'use strict';

/**
 * eventAnalyzer — Lambda handler triggered by DynamoDB Streams on EventsTable
 *
 * Trigger:  DynamoDB Streams (EventsTable, NEW_IMAGE, INSERT events only)
 *
 * Flow per record:
 *   filter (INSERT + status="processing") → skip "low" severity → AI analysis
 *     → update DynamoDB with AI results → publish to SNS if high/critical
 *     → track token usage in MetricsTable
 *
 * Skip conditions (event is left at status="processing" for rule-engine result):
 *   - Stream record is not an INSERT
 *   - Event status is not "processing"
 *   - Event severity is "low" (cost optimisation — AI adds no value here)
 *   - AI is disabled or circuit breaker is open (aiService handles fallback)
 *
 * AI fallback:
 *   If aiService returns { skipped: true }, the rule-engine severity (already
 *   stored on the event) is preserved.  The status is still moved to "analyzed"
 *   so downstream consumers don't wait indefinitely for an AI result.
 *
 * Error handling:
 *   Records are processed in parallel.  Any per-record failure is logged and
 *   will cause Lambda to retry the entire batch (DynamoDB Streams retries until
 *   the record expires from the shard).  Idempotent updates (SET if_not_exists
 *   for AI fields, UpdateItem keyed on eventId) make retries safe.
 */

const { DynamoDBClient }                    = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { unmarshall }                        = require('@aws-sdk/util-dynamodb');
const { SNSClient, PublishCommand }         = require('@aws-sdk/client-sns');
const { v4: uuidv4 }                        = require('uuid');

const logger             = require('../utils/logger');
const { analyzeEvent }   = require('../services/aiService');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start)
// ─────────────────────────────────────────────────────────────────────────────
const REGION        = process.env.AWS_REGION             || 'ap-south-1';
const EVENTS_TABLE  = process.env.DYNAMODB_EVENTS_TABLE;
const METRICS_TABLE = process.env.DYNAMODB_METRICS_TABLE;
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN;

// Severities that trigger an SNS CriticalAlerts notification.
const ALERT_SEVERITIES = new Set(['high', 'critical']);

// MetricsTable token-usage counters expire after 90 days.
const METRIC_TTL_SECS = 90 * 24 * 60 * 60;

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

const snsClient = new SNSClient({ region: REGION });

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DynamoDB Streams batch handler.
 *
 * @param {object} streamEvent - Lambda DynamoDB Streams event payload
 * @param {object[]} streamEvent.Records
 */
exports.handler = async (streamEvent) => {
  const batchStartMs = Date.now();
  const invocationId = uuidv4();
  const batchSize    = streamEvent.Records.length;

  const log = logger.child({ fn: 'eventAnalyzer', invocationId, batchSize });
  log.info('DynamoDB Streams batch received');

  // Process all records concurrently.
  const outcomes = await Promise.allSettled(
    streamEvent.Records.map((record) => processRecord(record, log)),
  );

  // Tally results.
  let analyzed = 0;
  let skipped  = 0;
  let failed   = 0;

  outcomes.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      failed++;
      log.error('Record processing failed', {
        recordIndex: i,
        error:       outcome.reason?.message,
        stack:       outcome.reason?.stack,
      });
    } else if (outcome.value?.skipped) {
      skipped++;
    } else {
      analyzed++;
    }
  });

  log.info('Batch complete', {
    batchSize,
    analyzed,
    skipped,
    failed,
    durationMs: Date.now() - batchStartMs,
  });

  // DynamoDB Streams does not support partial batch failures in the same way
  // as SQS — if we throw, the entire shard retries.  Letting it throw for
  // individual failures signals Lambda to retry, which is the correct behaviour
  // for transient DynamoDB/OpenAI errors.
  if (failed > 0) {
    throw new Error(
      `eventAnalyzer: ${failed} of ${batchSize} records failed — retrying batch`,
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// RECORD PROCESSING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single DynamoDB Streams record.
 *
 * @param {object} record    - Single DynamoDB Streams record
 * @param {object} parentLog - Parent Winston logger
 * @returns {Promise<{ skipped: boolean }>}
 */
async function processRecord(record, parentLog) {
  // ── Step 1: Filter — only process INSERT events ───────────────────────────
  if (record.eventName !== 'INSERT') {
    parentLog.debug('Skipping non-INSERT stream record', { eventName: record.eventName });
    return { skipped: true };
  }

  // ── Step 2: Unmarshal the DynamoDB NewImage ───────────────────────────────
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) {
    parentLog.warn('INSERT record has no NewImage — skipping');
    return { skipped: true };
  }

  const event = unmarshall(newImage);

  const log = parentLog.child({
    eventId:  event.eventId,
    severity: event.severity,
    status:   event.status,
  });

  // ── Step 3: Filter — only process events with status="processing" ─────────
  if (event.status !== 'processing') {
    log.debug('Skipping — event status is not "processing"', { status: event.status });
    return { skipped: true };
  }

  // ── Step 4: Cost optimisation — skip "low" severity events ───────────────
  if (event.severity === 'low') {
    log.debug('Skipping AI — rule engine already classified severity as "low"');
    // Move status to "analyzed" with no AI fields so the event doesn't stall.
    await markAnalyzedWithoutAI(event, log);
    return { skipped: true };
  }

  log.info('Starting AI analysis');

  // ── Step 5: Call OpenAI via aiService ─────────────────────────────────────
  const analysisStart = Date.now();
  const aiResult      = await analyzeEvent(event);
  const analysisDurationMs = Date.now() - analysisStart;

  log.debug('aiService returned', {
    skipped:    aiResult.skipped,
    reason:     aiResult.reason,
    aiSeverity: aiResult.severity,
    confidence: aiResult.confidence,
    durationMs: analysisDurationMs,
  });

  // ── Step 6: Determine effective severity & whether AI data is present ─────
  //
  // If aiService skipped (circuit open, retries failed, low confidence), we
  // keep the rule-engine severity that is already on the record and set
  // aiAnalyzedBy = "rule-engine" so consumers know what drove the result.
  const usedAI       = !aiResult.skipped;
  const finalSeverity = usedAI ? aiResult.severity : event.severity;
  const analyzedBy    = usedAI ? 'ai' : 'rule-engine';

  // ── Step 7: Update EventsTable with AI results ────────────────────────────
  await updateEventWithAnalysis(event, aiResult, finalSeverity, analyzedBy, log);

  // ── Step 8: Track token usage in MetricsTable (best-effort) ──────────────
  if (usedAI && aiResult.tokenUsage?.totalTokens > 0) {
    await trackTokenUsage(event, aiResult.tokenUsage, log).catch((err) => {
      log.warn('Token usage metric failed — skipping', { error: err.message });
    });
  }

  // ── Step 9: Publish to SNS if severity is high or critical ───────────────
  if (ALERT_SEVERITIES.has(finalSeverity)) {
    await publishToSNS(event, aiResult, finalSeverity, analyzedBy, log);
  }

  log.info('Event analyzed', {
    finalSeverity,
    analyzedBy,
    usedAI,
    analysisDurationMs,
    totalTokens: aiResult.tokenUsage?.totalTokens,
    published:   ALERT_SEVERITIES.has(finalSeverity),
  });

  return { skipped: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write AI analysis results onto an existing EventsTable record.
 *
 * Uses conditional update to guard against race conditions on redelivery
 * (only updates when status is still "processing" OR when the AI fields are
 * not yet populated — safe to replay).
 *
 * @param {object} event
 * @param {object} aiResult
 * @param {string} finalSeverity
 * @param {string} analyzedBy     - "ai" | "rule-engine"
 * @param {object} log
 */
async function updateEventWithAnalysis(event, aiResult, finalSeverity, analyzedBy, log) {
  const now = new Date().toISOString();

  // Build update expression based on whether AI data is present.
  const updateParts = [
    'SET #status     = :analyzed',
    '    #severity   = :finalSeverity',
    '    #analyzedBy = :analyzedBy',
    '    #analyzedAt = :now',
  ];

  const names = {
    '#status':     'status',
    '#severity':   'severity',
    '#analyzedBy': 'aiAnalyzedBy',
    '#analyzedAt': 'analyzedAt',
  };

  const values = {
    ':analyzed':      'analyzed',
    ':finalSeverity': finalSeverity,
    ':analyzedBy':    analyzedBy,
    ':now':           now,
  };

  if (!aiResult.skipped) {
    updateParts.push(
      '    #aiSummary        = :summary',
      '    #aiSeverity       = :aiSeverity',
      '    #aiRecommendation = :recommendation',
      '    #aiRootCause      = :rootCause',
      '    #aiConfidence     = :confidence',
      '    #aiDurationMs     = :durationMs',
    );
    Object.assign(names, {
      '#aiSummary':        'aiSummary',
      '#aiSeverity':       'aiSeverity',
      '#aiRecommendation': 'aiRecommendation',
      '#aiRootCause':      'aiRootCause',
      '#aiConfidence':     'aiConfidence',
      '#aiDurationMs':     'aiDurationMs',
    });
    Object.assign(values, {
      ':summary':        aiResult.summary,
      ':aiSeverity':     aiResult.severity,
      ':recommendation': aiResult.recommendation,
      ':rootCause':      aiResult.rootCause,
      ':confidence':     aiResult.confidence,
      ':durationMs':     aiResult.durationMs,
    });
  }

  try {
    await docClient.send(new UpdateCommand({
      TableName:                 EVENTS_TABLE,
      Key:                       { eventId: event.eventId, timestamp: event.timestamp },
      UpdateExpression:          updateParts.join(', '),
      ExpressionAttributeNames:  names,
      ExpressionAttributeValues: values,
    }));

    log.debug('EventsTable updated with analysis results');
  } catch (err) {
    log.error('DynamoDB UpdateItem failed for event analysis', {
      error: err.message,
      code:  err.name,
    });
    throw err;
  }
}

/**
 * Mark an event as analyzed without any AI fields.
 * Used for "low" severity events that are intentionally skipped.
 *
 * @param {object} event
 * @param {object} log
 */
async function markAnalyzedWithoutAI(event, log) {
  try {
    await docClient.send(new UpdateCommand({
      TableName:        EVENTS_TABLE,
      Key:              { eventId: event.eventId, timestamp: event.timestamp },
      UpdateExpression: 'SET #status = :analyzed, #analyzedBy = :by, #analyzedAt = :now',
      ExpressionAttributeNames: {
        '#status':     'status',
        '#analyzedBy': 'aiAnalyzedBy',
        '#analyzedAt': 'analyzedAt',
      },
      ExpressionAttributeValues: {
        ':analyzed': 'analyzed',
        ':by':       'skipped-low-severity',
        ':now':      new Date().toISOString(),
      },
    }));
    log.debug('EventsTable status updated to analyzed (no AI for low severity)');
  } catch (err) {
    // Non-critical — don't fail the batch for a status update on a low event.
    log.warn('Could not update status for low-severity event', { error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SNS PUBLISHING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish a CriticalAlerts SNS message when severity is "high" or "critical".
 *
 * The message body is a JSON string with event data + AI analysis merged so
 * subscribers (alertDispatcher Lambda, email, Slack) have everything they need.
 *
 * @param {object} event
 * @param {object} aiResult
 * @param {string} finalSeverity
 * @param {string} analyzedBy
 * @param {object} log
 */
async function publishToSNS(event, aiResult, finalSeverity, analyzedBy, log) {
  if (!SNS_TOPIC_ARN) {
    log.warn('SNS_TOPIC_ARN not configured — skipping alert publication');
    return;
  }

  const messageBody = {
    eventId:         event.eventId,
    timestamp:       event.timestamp,
    source:          event.source,
    type:            event.type,
    title:           event.title,
    description:     event.description,
    metadata:        event.metadata,
    severity:        finalSeverity,
    analyzedBy,
    // AI fields — present when analyzedBy === "ai"
    aiSummary:        aiResult.summary        ?? null,
    aiSeverity:       aiResult.severity       ?? null,
    aiRecommendation: aiResult.recommendation ?? null,
    aiRootCause:      aiResult.rootCause      ?? null,
    aiConfidence:     aiResult.confidence     ?? null,
    // Routing metadata for alertDispatcher
    alertType:       'severity-threshold',
    publishedAt:     new Date().toISOString(),
  };

  try {
    const publishStart = Date.now();

    await snsClient.send(new PublishCommand({
      TopicArn:  SNS_TOPIC_ARN,
      Message:   JSON.stringify(messageBody),
      Subject:   `[${finalSeverity.toUpperCase()}] ${event.title}`,
      MessageAttributes: {
        severity: { DataType: 'String', StringValue: finalSeverity },
        source:   { DataType: 'String', StringValue: event.source  },
        eventId:  { DataType: 'String', StringValue: event.eventId },
      },
    }));

    log.info('SNS CriticalAlerts published', {
      finalSeverity,
      topicArn:  SNS_TOPIC_ARN,
      publishMs: Date.now() - publishStart,
    });
  } catch (err) {
    // Log but don't throw — a failed SNS publish should not roll back the
    // DynamoDB write.  alertDispatcher will retry on its own.
    log.error('SNS publish failed', {
      error:    err.message,
      code:     err.name,
      topicArn: SNS_TOPIC_ARN,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// METRICS — TOKEN USAGE TRACKING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Atomically ADD token usage to per-hour counters in MetricsTable.
 *
 * Keys written:
 *   ai_tokens_total:<YYYY-MM-DDTHH>
 *   ai_tokens_prompt:<YYYY-MM-DDTHH>
 *   ai_tokens_completion:<YYYY-MM-DDTHH>
 *
 * @param {object} event
 * @param {{ promptTokens: number, completionTokens: number, totalTokens: number }} tokenUsage
 * @param {object} log
 */
async function trackTokenUsage(event, tokenUsage, log) {
  const window = new Date().toISOString().slice(0, 13);   // "YYYY-MM-DDTHH"
  const ttl    = Math.floor(Date.now() / 1000) + METRIC_TTL_SECS;

  const counters = [
    { metricKey: `ai_tokens_total:${window}`,      value: tokenUsage.totalTokens      },
    { metricKey: `ai_tokens_prompt:${window}`,     value: tokenUsage.promptTokens     },
    { metricKey: `ai_tokens_completion:${window}`, value: tokenUsage.completionTokens },
  ];

  const results = await Promise.allSettled(
    counters.map(({ metricKey, value }) => incrementTokenCounter(metricKey, value, ttl)),
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      log.warn('Token usage counter failed', {
        metricKey: counters[i].metricKey,
        error:     result.reason?.message,
      });
    }
  });
}

/**
 * Atomic ADD to a MetricsTable token counter.
 *
 * @param {string} metricKey
 * @param {number} amount
 * @param {number} ttl  Unix epoch expiry
 */
async function incrementTokenCounter(metricKey, amount, ttl) {
  const timestamp = new Date().toISOString().slice(0, 13);

  await docClient.send(new UpdateCommand({
    TableName: METRICS_TABLE,
    Key:       { metricKey, timestamp },
    UpdateExpression: [
      'SET #unit = if_not_exists(#unit, :unit)',
      '    #ttl  = if_not_exists(#ttl,  :ttl)',
      'ADD #value :amount',
    ].join(', '),
    ExpressionAttributeNames: {
      '#value': 'value',
      '#unit':  'unit',
      '#ttl':   'ttl',
    },
    ExpressionAttributeValues: {
      ':amount': amount,
      ':unit':   'Tokens',
      ':ttl':    ttl,
    },
  }));
}
