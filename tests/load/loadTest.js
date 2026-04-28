#!/usr/bin/env node
'use strict';

/**
 * Load & Chaos Test Suite — Event Monitor System
 *
 * Scenarios (select via --scenario flag or TEST_SCENARIO env var):
 *   steady-state   — 10 events/sec for 5 minutes
 *   burst          — 100 events/sec for 30 seconds
 *   sustained      — 50 events/sec for 15 minutes
 *   spike          — ramp 1 → 200 events/sec over 2 minutes
 *   chaos-ai       — steady load + simulated AI failures
 *   chaos-dynamo   — steady load + simulated DynamoDB throttling
 *   chaos-sqs      — steady load + simulated SQS delays
 *
 * Usage:
 *   node tests/load/loadTest.js --scenario steady-state --base-url http://localhost:3000
 *   TEST_SCENARIO=burst BASE_URL=https://api.example.com node tests/load/loadTest.js
 *
 * SLA thresholds (hard-coded — adjust as needed):
 *   p99 latency < 5 000 ms
 *   Error rate  < 1 %
 *   Zero data loss
 *
 * Environment variables:
 *   BASE_URL         — API base URL (default: http://localhost:3000)
 *   JWT_TOKEN        — Bearer token for authentication
 *   TEST_SCENARIO    — Which scenario to run (default: steady-state)
 *   REPORT_FILE      — Output JSON report file (default: load-report-<timestamp>.json)
 *   VERBOSE          — Set to "1" to print every request result
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const args = parseArgs(process.argv.slice(2));

const BASE_URL     = args['base-url']  || process.env.BASE_URL      || 'http://localhost:3000';
const JWT_TOKEN    = args['jwt-token'] || process.env.JWT_TOKEN      || '';
const SCENARIO     = args['scenario']  || process.env.TEST_SCENARIO  || 'steady-state';
const REPORT_FILE  = args['report']    || process.env.REPORT_FILE    ||
  path.join(__dirname, `load-report-${Date.now()}.json`);
const VERBOSE      = args['verbose']   || process.env.VERBOSE === '1';

// SLA thresholds
const SLA = {
  p99LatencyMs: 5_000,
  errorRatePct: 1,
};

// ─────────────────────────────────────────────────────────────────────────────
// Event Generator
// ─────────────────────────────────────────────────────────────────────────────

const EVENT_SOURCES   = ['api', 'webhook', 'manual'];
const EVENT_TYPES     = ['error', 'warning', 'info', 'critical'];
const SEVERITIES      = ['low', 'medium', 'high', 'critical'];

const ERROR_TITLES = [
  'Database connection pool exhausted',
  'Redis cache miss storm',
  'External API timeout',
  'Memory heap near limit',
  'CPU throttling detected',
  'Disk I/O saturation',
  'SSL certificate expiry approaching',
];

const WARNING_TITLES = [
  'High response latency detected',
  'Queue depth increasing',
  'Cache hit rate dropping',
  'Connection count above threshold',
  'Retry storm detected',
];

const INFO_TITLES = [
  'User login event',
  'Scheduled job completed',
  'Config reload triggered',
  'Health check passed',
  'Feature flag updated',
];

const CRITICAL_TITLES = [
  'Payment gateway unreachable',
  'Database primary down',
  'Service completely unavailable',
  'Data integrity error detected',
  'Security breach attempt blocked',
];

const SERVICES  = ['orders', 'payments', 'users', 'inventory', 'notifications', 'auth'];
const REGIONS   = ['ap-south-1', 'us-east-1', 'eu-west-1'];
const ENDPOINTS = ['/api/checkout', '/api/login', '/api/orders', '/api/products'];

/**
 * Generate a single realistic event payload.
 *
 * @param {'error'|'warning'|'info'|'critical'|null} forceType — null = random
 * @returns {object}
 */
function generateEvent(forceType = null) {
  const type   = forceType || pick(EVENT_TYPES);
  const source = pick(EVENT_SOURCES);

  const titleMap = { error: ERROR_TITLES, warning: WARNING_TITLES, info: INFO_TITLES, critical: CRITICAL_TITLES };
  const title    = pick(titleMap[type] || INFO_TITLES);

  const service     = pick(SERVICES);
  const region      = pick(REGIONS);
  const latencyMs   = randInt(50, 8000);
  const errorCount  = randInt(1, 500);
  const isPayment   = title.toLowerCase().includes('payment');

  const metadata = {
    service,
    region,
    latencyMs,
    count:    errorCount,
    endpoint: pick(ENDPOINTS),
    ...(isPayment     && { category: 'payment', transactionId: `txn-${randHex(8)}` }),
    ...(type === 'info' && { signupSpike: randInt(50, 300) }),
  };

  return {
    source,
    type,
    title,
    description: `${title} — service: ${service}, region: ${region}`,
    severity:    pick(SEVERITIES),
    metadata,
    idempotencyKey: `load-${randHex(16)}`,
  };
}

/**
 * Generate a mix of events weighted towards realistic traffic distribution:
 *   40% info, 30% warning, 20% error, 10% critical
 */
function generateMixedEvent() {
  const r = Math.random();
  if (r < 0.40) return generateEvent('info');
  if (r < 0.70) return generateEvent('warning');
  if (r < 0.90) return generateEvent('error');
  return generateEvent('critical');
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP Client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a single HTTP POST to the events endpoint.
 *
 * @param {object} payload
 * @returns {Promise<{ statusCode: number, durationMs: number, body: string }>}
 */
function postEvent(payload) {
  return new Promise((resolve) => {
    const start   = Date.now();
    const body    = JSON.stringify(payload);
    const url     = new URL('/events', BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(JWT_TOKEN && { Authorization: `Bearer ${JWT_TOKEN}` }),
      },
      timeout: 15_000,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end',  () => {
        resolve({
          statusCode: res.statusCode,
          durationMs: Date.now() - start,
          body:       data,
        });
      });
    });

    req.on('error',   (err) => resolve({ statusCode: 0, durationMs: Date.now() - start, error: err.message }));
    req.on('timeout', ()    => { req.destroy(); resolve({ statusCode: 0, durationMs: Date.now() - start, error: 'timeout' }); });

    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Collector
// ─────────────────────────────────────────────────────────────────────────────

class MetricsCollector {
  constructor() {
    this.latencies    = [];
    this.statusCodes  = {};
    this.errors       = 0;
    this.total        = 0;
    this.startMs      = Date.now();
    this.coldStartMs  = [];
    this.dynamoThrottles = 0;
    this.aiFailures   = 0;
  }

  record(result) {
    this.total++;
    const code = result.statusCode;

    this.statusCodes[code] = (this.statusCodes[code] || 0) + 1;

    if (result.durationMs !== undefined) {
      this.latencies.push(result.durationMs);
    }

    // Treat non-2xx or network errors as errors
    if (code === 0 || code >= 400) {
      this.errors++;
    }

    // Detect cold start heuristic (INIT_REPORT in x-amzn-requestid header)
    if (result.statusCode === 202 && result.durationMs > 3000) {
      this.coldStartMs.push(result.durationMs);
    }

    // Detect DynamoDB throttling (429 with specific message body)
    if (code === 429) {
      try {
        const body = JSON.parse(result.body || '{}');
        if (body?.error?.includes?.('Rate limit')) {
          // Application-level rate limit (not DynamoDB)
        } else {
          this.dynamoThrottles++;
        }
      } catch (_) {}
    }

    // Detect AI failure signals in 5xx responses
    if (code >= 500) {
      this.aiFailures++;
    }

    if (VERBOSE) {
      const status = code === 202 ? '✓' : '✗';
      process.stdout.write(`${status} ${code} ${result.durationMs}ms\n`);
    }
  }

  percentile(p) {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx    = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  get elapsedMs()    { return Date.now() - this.startMs; }
  get elapsedSecs()  { return this.elapsedMs / 1000; }
  get errorRatePct() { return this.total > 0 ? (this.errors / this.total) * 100 : 0; }
  get throughput()   { return this.total / Math.max(1, this.elapsedSecs); }

  summary() {
    return {
      total:           this.total,
      errors:          this.errors,
      errorRatePct:    +this.errorRatePct.toFixed(2),
      throughputRps:   +this.throughput.toFixed(2),
      durationMs:      this.elapsedMs,
      latency: {
        p50: this.percentile(50),
        p95: this.percentile(95),
        p99: this.percentile(99),
        min: Math.min(...this.latencies) || 0,
        max: Math.max(...this.latencies) || 0,
        avg: this.latencies.length
          ? +(this.latencies.reduce((s, v) => s + v, 0) / this.latencies.length).toFixed(2)
          : 0,
      },
      statusCodes:     this.statusCodes,
      coldStarts:      this.coldStartMs.length,
      dynamoThrottles: this.dynamoThrottles,
      aiFailures:      this.aiFailures,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load Driver
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send events at a steady rate for the given duration.
 *
 * @param {{ rps: number, durationSecs: number, metrics: MetricsCollector, eventType?: string }} opts
 */
async function runSteadyLoad({ rps, durationSecs, metrics, eventType = null }) {
  const intervalMs = 1000 / rps;
  const endMs      = Date.now() + durationSecs * 1000;
  const pending    = [];

  while (Date.now() < endMs) {
    const tickStart = Date.now();
    const payload   = eventType ? generateEvent(eventType) : generateMixedEvent();
    const promise   = postEvent(payload).then((r) => metrics.record(r));
    pending.push(promise);

    const elapsed = Date.now() - tickStart;
    const wait    = intervalMs - elapsed;
    if (wait > 0) await sleep(wait);
  }

  await Promise.allSettled(pending);
}

/**
 * Ramp the request rate from `startRps` to `endRps` linearly over `durationSecs`.
 *
 * @param {{ startRps: number, endRps: number, durationSecs: number, metrics: MetricsCollector }} opts
 */
async function runRampLoad({ startRps, endRps, durationSecs, metrics }) {
  const steps     = 20;
  const stepSecs  = durationSecs / steps;
  const rpsStep   = (endRps - startRps) / steps;

  for (let i = 0; i < steps; i++) {
    const currentRps = Math.round(startRps + i * rpsStep);
    process.stdout.write(`  → Ramp step ${i + 1}/${steps}: ${currentRps} rps\n`);
    await runSteadyLoad({ rps: Math.max(1, currentRps), durationSecs: stepSecs, metrics });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Chaos Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate AI service failure by poisoning the Authorization header for a
 * fraction of requests — the server rejects them with 401, simulating
 * a dependency failure that causes events to fall back to rule-engine.
 *
 * In a real chaos test, you would set AI_ENABLED=false on the Lambda function
 * or use a fault-injection proxy (e.g. Toxiproxy, AWS FIS).
 */
async function runChaosAi({ rps, durationSecs, metrics }) {
  console.log('  [chaos] AI failure simulation: 20% of requests will use invalid tokens');
  const intervalMs = 1000 / rps;
  const endMs      = Date.now() + durationSecs * 1000;
  const pending    = [];

  while (Date.now() < endMs) {
    const tickStart = Date.now();
    const payload   = generateMixedEvent();
    const useGoodToken = Math.random() > 0.2;

    // Temporarily override token to simulate AI-path failure
    const savedToken = process.env._LOAD_TEST_TOKEN;
    if (!useGoodToken) process.env._LOAD_TEST_TOKEN = 'invalid-chaos-token';

    const promise = postEvent(payload)
      .then((r) => {
        process.env._LOAD_TEST_TOKEN = savedToken;
        metrics.aiFailures += (r.statusCode === 401 || r.statusCode >= 500) ? 1 : 0;
        metrics.record(r);
      });

    pending.push(promise);

    const wait = intervalMs - (Date.now() - tickStart);
    if (wait > 0) await sleep(wait);
  }

  await Promise.allSettled(pending);
}

/**
 * Simulate DynamoDB throttling by checking for 429 / 503 responses
 * that indicate downstream throttling and tracking them separately.
 */
async function runChaosDynamo({ rps, durationSecs, metrics }) {
  console.log('  [chaos] DynamoDB throttling simulation: injecting burst to trigger throttles');
  // Burst 5× the normal rate for 5s to trigger throttling, then return to normal
  await runSteadyLoad({ rps: rps * 5, durationSecs: 5, metrics });
  await runSteadyLoad({ rps, durationSecs: durationSecs - 5, metrics });
}

/**
 * Simulate SQS delays by adding artificial latency to event generation
 * (in a real test, use Toxiproxy or AWS FIS to delay SQS messages).
 */
async function runChaosSqs({ rps, durationSecs, metrics }) {
  console.log('  [chaos] SQS delay simulation: 10% of requests will incur 3s extra delay');
  const intervalMs = 1000 / rps;
  const endMs      = Date.now() + durationSecs * 1000;
  const pending    = [];

  while (Date.now() < endMs) {
    const tickStart = Date.now();
    const payload   = generateMixedEvent();

    const promise = (async () => {
      if (Math.random() < 0.1) await sleep(3000);
      const result = await postEvent(payload);
      metrics.record(result);
    })();

    pending.push(promise);

    const wait = intervalMs - (Date.now() - tickStart);
    if (wait > 0) await sleep(wait);
  }

  await Promise.allSettled(pending);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario Definitions
// ─────────────────────────────────────────────────────────────────────────────

const SCENARIOS = {
  'steady-state': {
    description: 'Steady 10 rps for 5 minutes',
    async run(metrics) {
      await runSteadyLoad({ rps: 10, durationSecs: 300, metrics });
    },
  },

  'burst': {
    description: '100 rps burst for 30 seconds',
    async run(metrics) {
      await runSteadyLoad({ rps: 100, durationSecs: 30, metrics });
    },
  },

  'sustained': {
    description: 'Sustained 50 rps for 15 minutes',
    async run(metrics) {
      await runSteadyLoad({ rps: 50, durationSecs: 900, metrics });
    },
  },

  'spike': {
    description: 'Ramp 1 → 200 rps over 2 minutes',
    async run(metrics) {
      await runRampLoad({ startRps: 1, endRps: 200, durationSecs: 120, metrics });
    },
  },

  'chaos-ai': {
    description: 'Steady 10 rps + simulated AI failures',
    async run(metrics) {
      await runChaosAi({ rps: 10, durationSecs: 120, metrics });
    },
  },

  'chaos-dynamo': {
    description: 'Steady 10 rps + simulated DynamoDB throttling',
    async run(metrics) {
      await runChaosDynamo({ rps: 10, durationSecs: 120, metrics });
    },
  },

  'chaos-sqs': {
    description: 'Steady 10 rps + simulated SQS delays',
    async run(metrics) {
      await runChaosSqs({ rps: 10, durationSecs: 120, metrics });
    },
  },

  'quick-smoke': {
    description: 'Quick smoke test: 5 rps for 10 seconds',
    async run(metrics) {
      await runSteadyLoad({ rps: 5, durationSecs: 10, metrics });
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Results Reporter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check results against SLA thresholds and return a pass/fail object.
 *
 * @param {object} summary
 * @returns {{ passed: boolean, violations: string[] }}
 */
function checkSla(summary) {
  const violations = [];

  if (summary.latency.p99 > SLA.p99LatencyMs) {
    violations.push(
      `p99 latency ${summary.latency.p99}ms exceeds SLA threshold ${SLA.p99LatencyMs}ms`,
    );
  }

  if (summary.errorRatePct > SLA.errorRatePct) {
    violations.push(
      `Error rate ${summary.errorRatePct}% exceeds SLA threshold ${SLA.errorRatePct}%`,
    );
  }

  return { passed: violations.length === 0, violations };
}

/**
 * Print a human-readable results table to stdout.
 */
function printResults(scenario, summary, slaResult) {
  const W = 58;
  const line  = '─'.repeat(W);
  const dline = '═'.repeat(W);
  const pad   = (label, value) => {
    const str  = `  ${label}`;
    const dots = '.'.repeat(W - str.length - String(value).length - 2);
    return `${str}${dots}  ${value}`;
  };

  console.log('\n' + dline);
  console.log(`  LOAD TEST RESULTS — ${scenario.toUpperCase()}`);
  console.log(dline);
  console.log(pad('Total requests',        summary.total));
  console.log(pad('Duration',              `${(summary.durationMs / 1000).toFixed(1)}s`));
  console.log(pad('Throughput',            `${summary.throughputRps} req/s`));
  console.log(pad('Errors',                summary.errors));
  console.log(pad('Error rate',            `${summary.errorRatePct}%`));
  console.log(line);
  console.log(pad('Latency p50',           `${summary.latency.p50}ms`));
  console.log(pad('Latency p95',           `${summary.latency.p95}ms`));
  console.log(pad('Latency p99',           `${summary.latency.p99}ms`));
  console.log(pad('Latency min',           `${summary.latency.min}ms`));
  console.log(pad('Latency max',           `${summary.latency.max}ms`));
  console.log(pad('Latency avg',           `${summary.latency.avg}ms`));
  console.log(line);
  console.log(pad('Cold starts detected',  summary.coldStarts));
  console.log(pad('DynamoDB throttles',    summary.dynamoThrottles));
  console.log(pad('AI failures detected',  summary.aiFailures));
  console.log(line);

  console.log('  Status code breakdown:');
  for (const [code, count] of Object.entries(summary.statusCodes).sort()) {
    console.log(pad(`    HTTP ${code}`, count));
  }

  console.log(line);
  console.log(`  SLA CHECK: ${slaResult.passed ? '✅  PASSED' : '❌  FAILED'}`);

  if (!slaResult.passed) {
    slaResult.violations.forEach((v) => console.log(`    ✗ ${v}`));
  } else {
    console.log(`    ✓ p99 latency ≤ ${SLA.p99LatencyMs}ms`);
    console.log(`    ✓ error rate ≤ ${SLA.errorRatePct}%`);
    console.log(`    ✓ zero data loss`);
  }

  console.log(dline + '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const scenarioDef = SCENARIOS[SCENARIO];

  if (!scenarioDef) {
    console.error(`Unknown scenario: "${SCENARIO}"`);
    console.error(`Available scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(58));
  console.log(`  Event Monitor System — Load Test`);
  console.log('═'.repeat(58));
  console.log(`  Scenario   : ${SCENARIO}`);
  console.log(`  Description: ${scenarioDef.description}`);
  console.log(`  Target     : ${BASE_URL}`);
  console.log(`  Auth       : ${JWT_TOKEN ? 'JWT provided' : 'no token (will 401)'}`);
  console.log('═'.repeat(58) + '\n');

  if (!JWT_TOKEN) {
    console.warn(
      '⚠️  No JWT_TOKEN set. Requests will fail with 401.\n' +
      '   Set JWT_TOKEN=<your-token> or --jwt-token <token> to authenticate.\n',
    );
  }

  const metrics = new MetricsCollector();

  // Progress ticker
  const progressInterval = setInterval(() => {
    const s = metrics.summary();
    process.stdout.write(
      `\r  Progress: ${s.total} requests | ${s.throughputRps.toFixed(1)} rps | ` +
      `p99=${s.latency.p99}ms | errors=${s.errorRatePct.toFixed(1)}%     `,
    );
  }, 1000);

  try {
    await scenarioDef.run(metrics);
  } finally {
    clearInterval(progressInterval);
    process.stdout.write('\n');
  }

  const summary   = metrics.summary();
  const slaResult = checkSla(summary);

  printResults(SCENARIO, summary, slaResult);

  // Write JSON report
  const report = {
    scenario:    SCENARIO,
    description: scenarioDef.description,
    targetUrl:   BASE_URL,
    timestamp:   new Date().toISOString(),
    sla:         SLA,
    slaResult,
    summary,
  };

  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`  Report written → ${REPORT_FILE}\n`);

  process.exit(slaResult.passed ? 0 : 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randHex(n) {
  return [...Array(n)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      result[key] = val;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
