'use strict';

/**
 * dashboardAPI — Lambda handler for dashboard & events REST API
 *
 * Routes handled (all require JWT auth):
 *   GET /dashboard/stats        — aggregate stats (24h / 7d / 30d)
 *   GET /dashboard/trends       — hourly + daily time-series trend data
 *   GET /events                 — paginated, filtered event list (GSI-backed)
 *   GET /events/{eventId}       — single event detail with alerts + timeline
 *   GET /metrics/cost           — cost breakdown (admin role only)
 *
 * Response caching: 5-minute Cache-Control on all 200 responses.
 */

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { DynamoDBClient }                                   = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION  (read once at cold start)
// ─────────────────────────────────────────────────────────────────────────────
const REGION        = process.env.AWS_REGION             || 'ap-south-1';
const EVENTS_TABLE  = process.env.DYNAMODB_EVENTS_TABLE;
const ALERTS_TABLE  = process.env.DYNAMODB_ALERTS_TABLE;
const METRICS_TABLE = process.env.DYNAMODB_METRICS_TABLE;
const JWT_SECRET    = process.env.JWT_SECRET;
const JWT_ISSUER    = process.env.JWT_ISSUER   || 'event-monitor-system';
const JWT_AUDIENCE  = process.env.JWT_AUDIENCE || 'event-monitor-api';

const CACHE_TTL_SECS = 300;   // 5 minutes
const MAX_PAGE_SIZE  = 100;
const DEFAULT_LIMIT  = 50;

// Lambda memory assumptions for cost estimation (GB)
const LAMBDA_MEMORY_GB = {
  eventIngest:       0.125,
  eventProcessor:    0.25,
  eventAnalyzer:     0.25,
  alertDispatcher:   0.125,
  webhookReceiver:   0.125,
};
// AWS Lambda pricing constants (us-east-1 / ap-south-1 on-demand)
const LAMBDA_PRICE_PER_REQUEST  = 0.0000002;      // $0.20 / 1 M requests
const LAMBDA_PRICE_PER_GB_SEC   = 0.0000166667;   // $0.0000166667 / GB-second

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
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const startMs   = Date.now();
  const requestId = extractRequestId(event);
  const log       = logger.child({ requestId, fn: 'dashboardAPI' });

  log.info('Request received', {
    method:   event.httpMethod,
    path:     event.path,
    sourceIp: event.requestContext?.identity?.sourceIp,
  });

  try {
    // ── JWT verification ──────────────────────────────────────────────────────
    const authResult = verifyJwt(
      event.headers?.Authorization || event.headers?.authorization,
      log,
    );
    if (authResult.error) {
      return buildResponse(401, { error: authResult.error }, requestId, startMs);
    }
    const { claims } = authResult;

    if (!['admin', 'operator', 'viewer'].includes(claims.role)) {
      log.warn('Forbidden — insufficient role', { role: claims.role });
      return buildResponse(403, {
        error:   'Forbidden',
        message: 'viewer, operator, or admin role required',
      }, requestId, startMs);
    }

    // ── Route dispatch ────────────────────────────────────────────────────────
    const path   = event.path || '';
    const method = (event.httpMethod || 'GET').toUpperCase();

    if (method !== 'GET') {
      return buildResponse(405, { error: 'Method Not Allowed' }, requestId, startMs);
    }

    // GET /dashboard/stats
    if (path === '/dashboard/stats') {
      return await handleStats(event, requestId, startMs, log);
    }

    // GET /dashboard/trends
    if (path === '/dashboard/trends') {
      return await handleTrends(requestId, startMs, log);
    }

    // GET /metrics/cost  (admin only)
    if (path === '/metrics/cost') {
      if (claims.role !== 'admin') {
        return buildResponse(403, {
          error:   'Forbidden',
          message: 'admin role required to access cost metrics',
        }, requestId, startMs);
      }
      return await handleCost(event, requestId, startMs, log);
    }

    // GET /events/{eventId}  — check before bare /events to avoid false match
    const eventId =
      event.pathParameters?.eventId ||
      path.match(/^\/events\/([^/]+)$/)?.[1];

    if (eventId && path !== '/events') {
      return await handleEventDetail(eventId, requestId, startMs, log);
    }

    // GET /events
    if (path === '/events') {
      return await handleEventsList(event, requestId, startMs, log);
    }

    return buildResponse(404, { error: 'Not Found', message: `No route for GET ${path}` }, requestId, startMs);

  } catch (err) {
    log.error('Unhandled error in dashboardAPI', {
      error:           err.message,
      stack:           err.stack,
      totalDurationMs: Date.now() - startMs,
    });
    return buildResponse(500, {
      error:   'Internal Server Error',
      message: 'An unexpected error occurred. Check CloudWatch logs for details.',
    }, requestId, startMs);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /dashboard/stats?period=24h|7d|30d
 *
 * Returns:
 *   - total events + breakdown by severity (pie chart data)
 *   - breakdown by source (bar chart data)
 *   - alert success / failure rate
 *   - average AI analysis duration
 *   - system health summary
 */
async function handleStats(event, requestId, startMs, log) {
  const period = event.queryStringParameters?.period || '24h';
  const now    = new Date();

  // Compute DynamoDB window strings for each metric granularity
  const hourStartWindow = periodToHourWindow(period, now);   // "YYYY-MM-DDTHH"
  const dayStartWindow  = periodToDayWindow(period, now);    // "YYYY-MM-DD"

  // Fetch in parallel — hourly-granulated and daily-granulated metrics
  const [severityItems, sourceItems, alertStatusItems, analyzerItems] = await Promise.all([
    scanMetricsByPrefix('events_by_severity:', hourStartWindow),  // hourly
    scanMetricsByPrefix('events_by_source:',   dayStartWindow),   // daily
    scanMetricsByPrefix('alert_by_status:',    dayStartWindow),   // daily
    scanMetricsByPrefix('lambda_duration:eventAnalyzer:', hourStartWindow), // hourly
  ]);

  // Aggregate events by severity
  const bySeverity = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const item of severityItems) {
    const sev = item.metricKey.split(':')[1];
    if (Object.prototype.hasOwnProperty.call(bySeverity, sev)) {
      bySeverity[sev] += item.value || 0;
    }
  }
  const totalEvents = Object.values(bySeverity).reduce((sum, n) => sum + n, 0);

  // Aggregate events by source
  const bySource = { api: 0, webhook: 0, manual: 0 };
  for (const item of sourceItems) {
    const src = item.metricKey.split(':')[1];
    if (Object.prototype.hasOwnProperty.call(bySource, src)) {
      bySource[src] += item.value || 0;
    }
  }

  // Alert success / failure
  let alertsSent = 0, alertsFailed = 0;
  for (const item of alertStatusItems) {
    const status = item.metricKey.split(':')[1];
    if (status === 'sent')   alertsSent   += item.value || 0;
    if (status === 'failed') alertsFailed += item.value || 0;
  }
  const totalAlerts     = alertsSent + alertsFailed;
  const alertSuccessRate = totalAlerts > 0 ? Math.round((alertsSent / totalAlerts) * 100) : null;

  // Average AI analysis duration (Lambda duration metrics, unit = Milliseconds)
  let avgAiAnalysisMs = null;
  if (analyzerItems.length > 0) {
    const total = analyzerItems.reduce((sum, m) => sum + (m.value || 0), 0);
    avgAiAnalysisMs = Math.round(total / analyzerItems.length);
  }

  // System health: healthy if we have any event metrics in the period
  const latestMetric = severityItems.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  const health = {
    status:      totalEvents > 0 ? 'healthy' : 'unknown',
    lastEventAt: latestMetric?.timestamp ?? null,
  };

  log.info('Stats fetched', { period, totalEvents, totalAlerts });

  return buildResponse(200, {
    period,
    generatedAt: now.toISOString(),
    events: {
      total:      totalEvents,
      bySeverity,
      bySource,
    },
    alerts: {
      total:       totalAlerts,
      sent:        alertsSent,
      failed:      alertsFailed,
      successRate: alertSuccessRate,
    },
    ai: {
      avgAnalysisMs: avgAiAnalysisMs,
    },
    health,
  }, requestId, startMs, cachingHeaders());
}

/**
 * GET /events?severity=&source=&startDate=&endDate=&limit=&lastEvaluatedKey=
 *
 * Efficient GSI queries when severity or source filter is provided.
 * Falls back to a full scan for unfiltered or date-only queries.
 * Returns cursor-based pagination via base64-encoded lastEvaluatedKey.
 */
async function handleEventsList(event, requestId, startMs, log) {
  const qs = event.queryStringParameters || {};
  const {
    severity,
    source,
    startDate,
    endDate,
    limit:             limitParam,
    lastEvaluatedKey:  cursorParam,
  } = qs;

  const limit = Math.min(parseInt(limitParam, 10) || DEFAULT_LIMIT, MAX_PAGE_SIZE);

  // Decode pagination cursor
  let exclusiveStartKey;
  if (cursorParam) {
    try {
      exclusiveStartKey = JSON.parse(Buffer.from(cursorParam, 'base64url').toString('utf8'));
    } catch {
      return buildResponse(400, {
        error:   'Bad Request',
        message: 'lastEvaluatedKey is not a valid pagination cursor',
      }, requestId, startMs);
    }
  }

  let result;

  if (severity) {
    // ── severity-index GSI query ──────────────────────────────────────────────
    const keyExpr   = startDate && endDate
      ? 'severity = :severity AND #ts BETWEEN :startDate AND :endDate'
      : startDate
        ? 'severity = :severity AND #ts >= :startDate'
        : endDate
          ? 'severity = :severity AND #ts <= :endDate'
          : 'severity = :severity';

    const exprValues = { ':severity': severity };
    const exprNames  = {};
    if (startDate || endDate) {
      exprNames['#ts'] = 'timestamp';
      if (startDate) exprValues[':startDate'] = startDate;
      if (endDate)   exprValues[':endDate']   = endDate;
    }

    result = await docClient.send(new QueryCommand({
      TableName:                 EVENTS_TABLE,
      IndexName:                 'severity-index',
      KeyConditionExpression:    keyExpr,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length && { ExpressionAttributeNames: exprNames }),
      ScanIndexForward:  false,
      Limit:             limit,
      ExclusiveStartKey: exclusiveStartKey,
    }));

  } else if (source) {
    // ── source-index GSI query ────────────────────────────────────────────────
    const keyExpr   = startDate && endDate
      ? 'source = :source AND #ts BETWEEN :startDate AND :endDate'
      : startDate
        ? 'source = :source AND #ts >= :startDate'
        : endDate
          ? 'source = :source AND #ts <= :endDate'
          : 'source = :source';

    const exprValues = { ':source': source };
    const exprNames  = {};
    if (startDate || endDate) {
      exprNames['#ts'] = 'timestamp';
      if (startDate) exprValues[':startDate'] = startDate;
      if (endDate)   exprValues[':endDate']   = endDate;
    }

    result = await docClient.send(new QueryCommand({
      TableName:                 EVENTS_TABLE,
      IndexName:                 'source-index',
      KeyConditionExpression:    keyExpr,
      ExpressionAttributeValues: exprValues,
      ...(Object.keys(exprNames).length && { ExpressionAttributeNames: exprNames }),
      ScanIndexForward:  false,
      Limit:             limit,
      ExclusiveStartKey: exclusiveStartKey,
    }));

  } else {
    // ── Full scan with optional date filter ───────────────────────────────────
    const conditions = [];
    const exprNames  = {};
    const exprValues = {};

    if (startDate) {
      conditions.push('#ts >= :startDate');
      exprNames['#ts']     = 'timestamp';
      exprValues[':startDate'] = startDate;
    }
    if (endDate) {
      conditions.push('#ts <= :endDate');
      exprNames['#ts']    = 'timestamp';
      exprValues[':endDate'] = endDate;
    }

    result = await docClient.send(new ScanCommand({
      TableName:          EVENTS_TABLE,
      Limit:              limit,
      ExclusiveStartKey:  exclusiveStartKey,
      ...(conditions.length && {
        FilterExpression:          conditions.join(' AND '),
        ExpressionAttributeNames:  exprNames,
        ExpressionAttributeValues: exprValues,
      }),
    }));
  }

  // Encode next-page cursor as base64url
  const nextCursor = result.LastEvaluatedKey
    ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64url')
    : null;

  const items = result.Items || [];

  log.info('Events list fetched', {
    count:   items.length,
    filters: { severity, source, startDate, endDate },
    hasMore: !!nextCursor,
  });

  return buildResponse(200, {
    events:           items,
    count:            items.length,
    lastEvaluatedKey: nextCursor,
    hasMore:          !!nextCursor,
  }, requestId, startMs, cachingHeaders());
}

/**
 * GET /events/{eventId}
 *
 * Returns the event record, all related alert records, and a
 * human-readable processing timeline derived from event status fields.
 */
async function handleEventDetail(eventId, requestId, startMs, log) {
  // Query by PK only — SK (timestamp) is unknown at call time
  const eventResult = await docClient.send(new QueryCommand({
    TableName:                 EVENTS_TABLE,
    KeyConditionExpression:    'eventId = :id',
    ExpressionAttributeValues: { ':id': eventId },
    Limit: 1,
  }));

  const eventItem = eventResult.Items?.[0];
  if (!eventItem) {
    return buildResponse(404, {
      error:   'Not Found',
      message: `Event ${eventId} not found`,
    }, requestId, startMs);
  }

  // Fetch all alert records for this event
  const alertsResult = await docClient.send(new ScanCommand({
    TableName:                 ALERTS_TABLE,
    FilterExpression:          'eventId = :eventId',
    ExpressionAttributeValues: { ':eventId': eventId },
  }));

  const alerts   = alertsResult.Items || [];
  const timeline = buildTimeline(eventItem, alerts);

  log.info('Event detail fetched', { eventId, alertCount: alerts.length });

  return buildResponse(200, {
    event:    eventItem,
    alerts,
    timeline,
  }, requestId, startMs, cachingHeaders());
}

/**
 * GET /dashboard/trends
 *
 * Returns:
 *   - hourlyEventCounts: per-hour total for the last 24 h (all severities)
 *   - dailyEventCounts:  per-day breakdown by severity for the last 30 days
 *   - sourceTrends:      per-day breakdown by source for the last 30 days
 */
async function handleTrends(requestId, startMs, log) {
  const now = new Date();

  const hourStart24h = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 13);  // "YYYY-MM-DDTHH"
  const dayStart30d  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);  // "YYYY-MM-DD"

  const [hourlyItems, dailySevItems, dailySrcItems] = await Promise.all([
    scanMetricsByPrefix('events_by_severity:', hourStart24h),
    scanMetricsByPrefix('events_by_severity:', dayStart30d),
    scanMetricsByPrefix('events_by_source:',   dayStart30d),
  ]);

  // ── Hourly event counts (last 24 h) ─────────────────────────────────────────
  const hourlyTotals = {};
  for (const item of hourlyItems) {
    const window = item.metricKey.split(':')[2]; // "2026-04-10T14"
    hourlyTotals[window] = (hourlyTotals[window] || 0) + (item.value || 0);
  }

  const hourlyEventCounts = [];
  for (let h = 23; h >= 0; h--) {
    const d   = new Date(now.getTime() - h * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 13);
    hourlyEventCounts.push({ window: key, count: hourlyTotals[key] || 0 });
  }

  // ── Daily severity breakdown (last 30 days) ───────────────────────────────
  const dailySevMap = {};
  for (const item of dailySevItems) {
    const parts    = item.metricKey.split(':');
    const severity = parts[1];
    const window   = parts[2]; // "2026-04-10"
    if (!dailySevMap[window]) {
      dailySevMap[window] = { low: 0, medium: 0, high: 0, critical: 0 };
    }
    if (Object.prototype.hasOwnProperty.call(dailySevMap[window], severity)) {
      dailySevMap[window][severity] += item.value || 0;
    }
  }

  const dailyEventCounts = [];
  for (let d = 29; d >= 0; d--) {
    const date  = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    const key   = date.toISOString().slice(0, 10);
    const sevs  = dailySevMap[key] || { low: 0, medium: 0, high: 0, critical: 0 };
    dailyEventCounts.push({
      date:  key,
      total: Object.values(sevs).reduce((sum, n) => sum + n, 0),
      ...sevs,
    });
  }

  // ── Daily source breakdown (last 30 days) ─────────────────────────────────
  const dailySrcMap = {};
  for (const item of dailySrcItems) {
    const parts  = item.metricKey.split(':');
    const source = parts[1];
    const window = parts[2];
    if (!dailySrcMap[window]) {
      dailySrcMap[window] = { api: 0, webhook: 0, manual: 0 };
    }
    if (Object.prototype.hasOwnProperty.call(dailySrcMap[window], source)) {
      dailySrcMap[window][source] += item.value || 0;
    }
  }

  const sourceTrends = [];
  for (let d = 29; d >= 0; d--) {
    const date = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);
    const key  = date.toISOString().slice(0, 10);
    sourceTrends.push({ date: key, ...(dailySrcMap[key] || { api: 0, webhook: 0, manual: 0 }) });
  }

  log.info('Trends fetched', {
    hourlyPoints: hourlyEventCounts.length,
    dailyPoints:  dailyEventCounts.length,
  });

  return buildResponse(200, {
    generatedAt:       now.toISOString(),
    hourlyEventCounts,
    dailyEventCounts,
    sourceTrends,
  }, requestId, startMs, cachingHeaders());
}

/**
 * GET /metrics/cost?period=7d|24h|30d  (admin only)
 *
 * Returns:
 *   - AI token usage by model + daily cost
 *   - Lambda invocation estimates + duration-based cost
 *   - DynamoDB cost note (not tracked inline; refer to Cost Explorer)
 *   - Total estimated daily cost
 */
async function handleCost(event, requestId, startMs, log) {
  const period = event.queryStringParameters?.period || '7d';
  const now    = new Date();

  const hourStartWindow = periodToHourWindow(period, now);
  const dayStartWindow  = periodToDayWindow(period, now);

  const [aiTokenItems, aiCostItems, lambdaItems] = await Promise.all([
    scanMetricsByPrefix('ai_tokens:',        dayStartWindow),
    scanMetricsByPrefix('ai_cost:',          dayStartWindow),
    scanMetricsByPrefix('lambda_duration:',  hourStartWindow),
  ]);

  // ── AI token usage ─────────────────────────────────────────────────────────
  const tokensByModel = {};
  for (const item of aiTokenItems) {
    const model = item.metricKey.split(':')[1];
    tokensByModel[model] = (tokensByModel[model] || 0) + (item.value || 0);
  }

  // ── AI costs (USD already stored) ─────────────────────────────────────────
  let totalAiCostUSD = 0;
  const aiCostByDay  = {};
  for (const item of aiCostItems) {
    const day = item.metricKey.split(':')[1]; // "2026-04-10"
    aiCostByDay[day]  = (aiCostByDay[day] || 0) + (item.value || 0);
    totalAiCostUSD   += item.value || 0;
  }

  const aiCostByDayArr = Object.entries(aiCostByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, costUSD]) => ({ day, costUSD: round6(costUSD) }));

  // ── Lambda costs ───────────────────────────────────────────────────────────
  // Each MetricsTable item for lambda_duration tracks a single invocation's
  // duration (value = ms).  We aggregate by function name.
  const lambdaStats = {};
  for (const item of lambdaItems) {
    const fnName = item.metricKey.split(':')[1];
    if (!lambdaStats[fnName]) {
      lambdaStats[fnName] = { invocations: 0, totalDurationMs: 0 };
    }
    lambdaStats[fnName].invocations     += 1;
    lambdaStats[fnName].totalDurationMs += item.value || 0;
  }

  let totalLambdaCostUSD = 0;
  const lambdaFunctions  = Object.entries(lambdaStats).map(([fn, stats]) => {
    const memGb     = LAMBDA_MEMORY_GB[fn] ?? 0.128;
    const gbSeconds = (stats.totalDurationMs / 1000) * memGb;
    const cost      = (stats.invocations * LAMBDA_PRICE_PER_REQUEST)
                    + (gbSeconds          * LAMBDA_PRICE_PER_GB_SEC);
    totalLambdaCostUSD += cost;
    return {
      function:         fn,
      invocations:      stats.invocations,
      avgDurationMs:    stats.invocations > 0
        ? Math.round(stats.totalDurationMs / stats.invocations)
        : 0,
      estimatedCostUSD: round6(cost),
    };
  });

  const totalEstimatedCostUSD = totalAiCostUSD + totalLambdaCostUSD;

  log.info('Cost data fetched', { period, totalAiCostUSD: round6(totalAiCostUSD), totalLambdaCostUSD: round6(totalLambdaCostUSD) });

  return buildResponse(200, {
    period,
    generatedAt: now.toISOString(),
    ai: {
      tokensByModel,
      costByDay:    aiCostByDayArr,
      totalCostUSD: round6(totalAiCostUSD),
    },
    lambda: {
      functions:    lambdaFunctions,
      totalCostUSD: round6(totalLambdaCostUSD),
    },
    dynamodb: {
      note: 'DynamoDB costs are not tracked in-band. Check AWS Cost Explorer for actual charges.',
    },
    totalEstimatedCostUSD: round6(totalEstimatedCostUSD),
  }, requestId, startMs, cachingHeaders());
}

// ─────────────────────────────────────────────────────────────────────────────
// TIMELINE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a human-readable processing timeline from an event's status fields
 * and its associated alert records.
 *
 * @param {object}   event  - EventsTable item
 * @param {object[]} alerts - Related AlertsTable items
 * @returns {object[]} Ordered timeline steps
 */
function buildTimeline(event, alerts) {
  const timeline = [];

  // ingested — always present
  timeline.push({
    step:      'ingested',
    timestamp: event.timestamp ?? null,
    status:    'completed',
  });

  // processed
  const processed = ['processing', 'analyzed', 'alerted'].includes(event.status);
  timeline.push({
    step:      'processed',
    timestamp: event.processedAt ?? null,
    status:    processed ? 'completed' : 'pending',
  });

  // analyzed
  const analyzed = ['analyzed', 'alerted'].includes(event.status);
  timeline.push({
    step:      'analyzed',
    timestamp: event.analyzedAt ?? null,
    status:    analyzed ? 'completed' : processed ? 'pending' : 'not_reached',
    aiUsed:    analyzed ? !!(event.aiSummary) : undefined,
  });

  // alerted
  if (event.status === 'alerted') {
    const sentAlert = alerts.find((a) => a.status === 'sent');
    timeline.push({
      step:      'alerted',
      timestamp: sentAlert?.sentAt ?? null,
      status:    'completed',
      channels:  alerts.map((a) => ({ channel: a.channel, status: a.status })),
    });
  } else {
    timeline.push({
      step:   'alerted',
      status: analyzed ? 'pending' : 'not_reached',
    });
  }

  return timeline;
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMODB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan MetricsTable for all items whose metricKey begins with `prefix`
 * and whose timestamp (sort key) is >= `startWindowStr`.
 *
 * Paginates transparently; returns all matching items as a flat array.
 * Metric scans are best-effort — a single failed page throws and the caller's
 * try/catch returns a 500, which is preferable to silently returning partial data.
 *
 * @param {string} prefix          - metricKey prefix to match (begins_with)
 * @param {string} startWindowStr  - minimum timestamp value (inclusive)
 * @returns {Promise<object[]>}
 */
async function scanMetricsByPrefix(prefix, startWindowStr) {
  const items = [];
  let lastKey;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName:                 METRICS_TABLE,
      FilterExpression:          'begins_with(metricKey, :prefix) AND #ts >= :start',
      ExpressionAttributeNames:  { '#ts': 'timestamp' },
      ExpressionAttributeValues: { ':prefix': prefix, ':start': startWindowStr },
      ExclusiveStartKey:         lastKey,
    }));

    if (result.Items?.length) {
      items.push(...result.Items);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERIOD HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the oldest hourly window string ("YYYY-MM-DDTHH") included
 * in the requested period.  Used for hourly-granulated metrics.
 */
function periodToHourWindow(period, now = new Date()) {
  const ms = periodToMs(period);
  return new Date(now.getTime() - ms).toISOString().slice(0, 13);
}

/**
 * Return the oldest daily window string ("YYYY-MM-DD") included
 * in the requested period.  Used for daily-granulated metrics.
 */
function periodToDayWindow(period, now = new Date()) {
  const ms = periodToMs(period);
  return new Date(now.getTime() - ms).toISOString().slice(0, 10);
}

function periodToMs(period) {
  if (period === '7d')  return 7  * 24 * 60 * 60 * 1000;
  if (period === '30d') return 30 * 24 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000; // default: 24h
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT VERIFICATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse and verify a Bearer JWT from the Authorization header.
 *
 * Returns `{ claims }` on success or `{ error: string }` on failure.
 * Never throws — callers check the discriminant field.
 *
 * @param {string|undefined} authHeader
 * @param {object}           log
 * @returns {{ claims?: object, error?: string }}
 */
function verifyJwt(authHeader, log) {
  if (!authHeader) {
    return { error: 'Authorization header is required' };
  }
  if (!authHeader.startsWith('Bearer ')) {
    return { error: 'Authorization header must use Bearer scheme' };
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return { error: 'Bearer token is empty' };
  }

  try {
    const claims = jwt.verify(token, JWT_SECRET, {
      issuer:   JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    return { claims };
  } catch (err) {
    const reason =
      err.name === 'TokenExpiredError' ? 'Token has expired' :
      err.name === 'JsonWebTokenError' ? 'Token is invalid or malformed' :
      err.name === 'NotBeforeError'    ? 'Token is not yet valid' :
                                         'Token verification failed';
    log.warn('JWT verification failed', { reason, jwtError: err.name });
    return { error: reason };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RESPONSE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an API Gateway proxy integration response.
 *
 * Security headers are always applied.  GET endpoints pass `cachingHeaders()`
 * as extraHeaders; error responses default to `Cache-Control: no-store`.
 *
 * @param {number} statusCode
 * @param {object} body
 * @param {string} requestId
 * @param {number} startMs
 * @param {object} [extraHeaders]
 * @returns {object}
 */
function buildResponse(statusCode, body, requestId, startMs, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type':              'application/json',
      'X-Request-ID':              requestId,
      'X-Duration-Ms':             String(Date.now() - startMs),
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options':    'nosniff',
      'X-Frame-Options':           'DENY',
      'Cache-Control':             'no-store',
      ...extraHeaders,
    },
    body: JSON.stringify({ ...body, requestId }),
  };
}

/** 5-minute public caching headers for successful GET responses. */
function cachingHeaders() {
  return {
    'Cache-Control': `public, max-age=${CACHE_TTL_SECS}, stale-while-revalidate=60`,
    'Vary':          'Authorization',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Extract or generate a request ID from API Gateway event headers. */
function extractRequestId(event) {
  return (
    event.headers?.['x-request-id']  ||
    event.headers?.['X-Request-Id']  ||
    event.headers?.['X-Request-ID']  ||
    event.requestContext?.requestId  ||
    uuidv4()
  );
}

/** Round a float to 6 significant decimal places for cost display. */
function round6(n) {
  return parseFloat(n.toFixed(6));
}
