'use strict';

/**
 * webhookTransformers.js
 *
 * Converts source-specific webhook payloads into the canonical Event schema:
 *   { source, type, severity, title, description, metadata }
 *
 * The handler owns auth/routing; these functions own mapping logic only.
 * Each transformer is a pure function — no I/O, no side effects.
 *
 * Supported sources: github | stripe | datadog | generic
 *
 * Adding a new source:
 *   1. Add its name to SUPPORTED_SOURCES
 *   2. Write a transformXxx(payload, headers) function below
 *   3. Register it in TRANSFORMERS map at the bottom
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SUPPORTED_SOURCES = ['github', 'stripe', 'datadog', 'generic'];

// Maximum lengths mirror eventModel Joi constraints
const MAX_TITLE       = 200;
const MAX_DESCRIPTION = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transform a raw webhook payload into a canonical event object.
 *
 * @param {string} source  - One of SUPPORTED_SOURCES
 * @param {object} payload - Already-parsed webhook body
 * @param {object} headers - Raw request headers (lowercase keys)
 * @returns {object}  Partial event: { source, type, severity, title, description, metadata }
 * @throws  {Error}   If source is unsupported or payload cannot be mapped
 */
function transform(source, payload, headers) {
  const transformer = TRANSFORMERS[source];
  if (!transformer) {
    throw Object.assign(new Error(`Unsupported webhook source: "${source}"`), { code: 'UNSUPPORTED_SOURCE' });
  }
  const result = transformer(payload, headers);
  return sanitise(result, source);
}

/**
 * Derive a stable idempotency key from source-specific identifiers.
 * These are unique IDs the webhook provider already assigns; using them
 * means the same webhook delivery can never be double-processed.
 *
 * @param {string} source
 * @param {object} payload
 * @param {object} headers
 * @returns {string}
 */
function deriveIdempotencyKey(source, payload, headers) {
  switch (source) {
    case 'github':
      // X-GitHub-Delivery is a UUID assigned per delivery attempt
      return `github:${headers['x-github-delivery'] || headers['X-GitHub-Delivery'] || fallbackKey(payload)}`;

    case 'stripe':
      // Stripe event objects have a globally-unique `id` like "evt_1..."
      return `stripe:${payload.id || fallbackKey(payload)}`;

    case 'datadog':
      // Datadog monitor alerts include `alert_id` and `event_id`
      return `datadog:${payload.alert_id || payload.event_id || fallbackKey(payload)}`;

    case 'generic':
    default:
      return `generic:${payload.id || payload.eventId || fallbackKey(payload)}`;
  }
}

/**
 * Extract the event timestamp from the source payload.
 * Used by the handler for replay-attack detection.
 *
 * @returns {number|null}  Unix epoch seconds, or null if unavailable
 */
function extractSourceTimestamp(source, payload, headers) {
  switch (source) {
    case 'github': {
      // No standard timestamp in GitHub headers; use payload if present
      const ts = payload.repository?.pushed_at
        || payload.pull_request?.updated_at
        || payload.issue?.updated_at;
      return ts ? Math.floor(new Date(ts).getTime() / 1000) : null;
    }
    case 'stripe': {
      // `created` is a Unix timestamp in all Stripe event objects
      return typeof payload.created === 'number' ? payload.created : null;
    }
    case 'datadog': {
      // `last_updated` is epoch seconds in monitor webhook payloads
      return payload.last_updated || payload.date || null;
    }
    default:
      return payload.timestamp
        ? Math.floor(new Date(payload.timestamp).getTime() / 1000)
        : null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GITHUB TRANSFORMER
// Docs: https://docs.github.com/en/webhooks/webhook-events-and-payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps GitHub event types (from X-GitHub-Event header) to canonical events.
 *
 * Handled events: push, pull_request, issues, workflow_run,
 *                 deployment_status, release, create, delete, ping
 */
function transformGitHub(payload, headers) {
  const ghEvent = (headers['x-github-event'] || headers['X-GitHub-Event'] || '').toLowerCase();
  const repo    = payload.repository?.full_name || payload.repository?.name || 'unknown-repo';
  const sender  = payload.sender?.login || 'unknown';

  switch (ghEvent) {
    case 'ping':
      return {
        type:        'info',
        severity:    'low',
        title:       `GitHub webhook connected for ${repo}`,
        description: `Webhook ping received. Hook ID: ${payload.hook_id}. Zen: "${payload.zen}"`,
        metadata:    { hookId: payload.hook_id, zen: payload.zen, repo },
      };

    case 'push': {
      const branch   = (payload.ref || '').replace('refs/heads/', '');
      const commits  = Array.isArray(payload.commits) ? payload.commits.length : 0;
      const isMain   = ['main', 'master', 'production', 'prod'].includes(branch);
      return {
        type:        'info',
        severity:    isMain ? 'medium' : 'low',
        title:       `Push to ${repo}/${branch} (${commits} commit${commits !== 1 ? 's' : ''})`,
        description: formatCommits(payload.commits, payload.compare),
        metadata:    { repo, branch, commits, pusher: payload.pusher?.name || sender, compare: payload.compare, isMainBranch: isMain },
      };
    }

    case 'pull_request': {
      const action = payload.action || '';
      const pr     = payload.pull_request || {};
      const isMerge = action === 'closed' && pr.merged === true;
      return {
        type:        isMerge ? 'info' : 'info',
        severity:    'low',
        title:       `PR #${pr.number} ${isMerge ? 'merged' : action}: ${truncate(pr.title, 120)}`,
        description: `${pr.html_url}\nBy ${pr.user?.login}. ${pr.additions || 0} additions, ${pr.deletions || 0} deletions across ${pr.changed_files || 0} files.`,
        metadata:    { repo, prNumber: pr.number, action, merged: pr.merged || false, author: pr.user?.login, url: pr.html_url },
      };
    }

    case 'issues': {
      const action = payload.action || '';
      const issue  = payload.issue || {};
      const severity = action === 'opened' && (issue.labels || []).some((l) => l.name === 'critical') ? 'high' : 'low';
      return {
        type:        'warning',
        severity,
        title:       `Issue #${issue.number} ${action}: ${truncate(issue.title, 120)}`,
        description: `${issue.html_url}\nOpened by ${issue.user?.login}.\n${truncate(issue.body || '', 500)}`,
        metadata:    { repo, issueNumber: issue.number, action, author: issue.user?.login, labels: (issue.labels || []).map((l) => l.name), url: issue.html_url },
      };
    }

    case 'workflow_run': {
      const wf         = payload.workflow_run || {};
      const conclusion = wf.conclusion || '';   // success | failure | cancelled | skipped | timed_out
      const isFailure  = ['failure', 'timed_out'].includes(conclusion);
      return {
        type:        isFailure ? 'error' : 'info',
        severity:    isFailure ? 'high'  : 'low',
        title:       `Workflow "${wf.name}" ${conclusion || wf.status} on ${repo}`,
        description: `Workflow: ${wf.html_url}\nBranch: ${wf.head_branch}\nCommit: ${wf.head_sha?.slice(0, 7)}\nConclusion: ${conclusion}`,
        metadata:    { repo, workflowName: wf.name, conclusion, branch: wf.head_branch, runId: wf.id, runNumber: wf.run_number, url: wf.html_url },
      };
    }

    case 'deployment_status': {
      const ds    = payload.deployment_status || {};
      const dep   = payload.deployment || {};
      const state = ds.state || '';   // pending | in_progress | success | failure | error
      const isFail = ['failure', 'error'].includes(state);
      return {
        type:        isFail ? 'error' : 'info',
        severity:    isFail ? 'high'  : 'low',
        title:       `Deployment to "${dep.environment}" ${state} on ${repo}`,
        description: `${ds.target_url || 'No URL'}\nCommit: ${dep.sha?.slice(0, 7)}\nDescription: ${ds.description || 'none'}`,
        metadata:    { repo, environment: dep.environment, state, sha: dep.sha, creator: dep.creator?.login, url: ds.target_url },
      };
    }

    case 'release': {
      const rel    = payload.release || {};
      const action = payload.action || '';
      return {
        type:        'info',
        severity:    'low',
        title:       `Release ${rel.tag_name} ${action} on ${repo}`,
        description: `${rel.html_url}\nAuthor: ${rel.author?.login}\n${truncate(rel.body || '', 500)}`,
        metadata:    { repo, tag: rel.tag_name, action, prerelease: rel.prerelease || false, author: rel.author?.login, url: rel.html_url },
      };
    }

    case 'create':
    case 'delete': {
      const refType = payload.ref_type || 'ref';   // branch | tag
      return {
        type:        'info',
        severity:    'low',
        title:       `${refType} "${payload.ref}" ${ghEvent}d on ${repo}`,
        description: `${ghEvent === 'create' ? 'Created' : 'Deleted'} ${refType} "${payload.ref}" in ${repo} by ${sender}.`,
        metadata:    { repo, ref: payload.ref, refType, sender },
      };
    }

    default:
      // Unknown event type — capture as-is for observability
      return {
        type:        'info',
        severity:    'low',
        title:       `GitHub event "${ghEvent}" received from ${repo}`,
        description: `Unhandled GitHub event type. Raw action: ${payload.action || 'n/a'}`,
        metadata:    { repo, ghEvent, action: payload.action, sender },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STRIPE TRANSFORMER
// Docs: https://stripe.com/docs/api/events/types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps Stripe event objects (payload.type) to canonical events.
 *
 * Stripe events always have: id, type, created, livemode, data.object
 */
function transformStripe(payload, _headers) {
  const stripeType = payload.type || '';
  const obj        = payload.data?.object || {};
  const isLive     = payload.livemode === true;
  const envTag     = isLive ? '[LIVE]' : '[TEST]';

  // ── Payments ────────────────────────────────────────────────────────────────
  if (stripeType === 'payment_intent.payment_failed') {
    return {
      type:        'error',
      severity:    'high',
      title:       `${envTag} Payment failed — ${formatCurrency(obj.amount, obj.currency)}`,
      description: `Payment intent ${obj.id} failed.\nCode: ${obj.last_payment_error?.code || 'unknown'}\nMessage: ${obj.last_payment_error?.message || 'none'}\nCustomer: ${obj.customer || 'guest'}`,
      metadata:    { stripeEventId: payload.id, stripeType, paymentIntentId: obj.id, amount: obj.amount, currency: obj.currency, errorCode: obj.last_payment_error?.code, customerId: obj.customer, isLive },
    };
  }

  if (stripeType === 'payment_intent.succeeded') {
    return {
      type:        'info',
      severity:    'low',
      title:       `${envTag} Payment succeeded — ${formatCurrency(obj.amount, obj.currency)}`,
      description: `Payment intent ${obj.id} succeeded.\nCustomer: ${obj.customer || 'guest'}`,
      metadata:    { stripeEventId: payload.id, stripeType, paymentIntentId: obj.id, amount: obj.amount, currency: obj.currency, customerId: obj.customer, isLive },
    };
  }

  if (stripeType === 'charge.failed') {
    return {
      type:        'error',
      severity:    'medium',
      title:       `${envTag} Charge failed — ${formatCurrency(obj.amount, obj.currency)}`,
      description: `Charge ${obj.id} failed.\nCode: ${obj.failure_code || 'unknown'}\nMessage: ${obj.failure_message || 'none'}`,
      metadata:    { stripeEventId: payload.id, stripeType, chargeId: obj.id, amount: obj.amount, currency: obj.currency, failureCode: obj.failure_code, isLive },
    };
  }

  if (stripeType === 'charge.dispute.created') {
    return {
      type:        'warning',
      severity:    'high',
      title:       `${envTag} Chargeback dispute opened — ${formatCurrency(obj.amount, obj.currency)}`,
      description: `Dispute ${obj.id} opened on charge ${obj.charge}.\nReason: ${obj.reason}\nStatus: ${obj.status}`,
      metadata:    { stripeEventId: payload.id, stripeType, disputeId: obj.id, chargeId: obj.charge, reason: obj.reason, amount: obj.amount, isLive },
    };
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────
  if (stripeType === 'invoice.payment_failed') {
    const attempt = obj.attempt_count || 1;
    return {
      type:        'error',
      severity:    attempt >= 3 ? 'critical' : 'high',
      title:       `${envTag} Invoice payment failed (attempt ${attempt}) — ${formatCurrency(obj.amount_due, obj.currency)}`,
      description: `Invoice ${obj.id} payment failed.\nCustomer: ${obj.customer}\nNext retry: ${obj.next_payment_attempt ? new Date(obj.next_payment_attempt * 1000).toISOString() : 'none'}`,
      metadata:    { stripeEventId: payload.id, stripeType, invoiceId: obj.id, amount: obj.amount_due, currency: obj.currency, attemptCount: attempt, customerId: obj.customer, isLive },
    };
  }

  if (stripeType === 'customer.subscription.deleted') {
    return {
      type:        'warning',
      severity:    'high',
      title:       `${envTag} Subscription cancelled — customer ${obj.customer}`,
      description: `Subscription ${obj.id} was cancelled (status: ${obj.status}).\nCancel reason: ${obj.cancellation_details?.reason || 'unknown'}`,
      metadata:    { stripeEventId: payload.id, stripeType, subscriptionId: obj.id, customerId: obj.customer, status: obj.status, isLive },
    };
  }

  // ── Fraud ────────────────────────────────────────────────────────────────────
  if (stripeType === 'radar.early_fraud_warning.created') {
    return {
      type:        'critical',
      severity:    'critical',
      title:       `${envTag} Stripe Radar: Early fraud warning on charge ${obj.charge}`,
      description: `Fraud warning ${obj.id}.\nFraud type: ${obj.fraud_type}\nCharge: ${obj.charge}`,
      metadata:    { stripeEventId: payload.id, stripeType, warningId: obj.id, chargeId: obj.charge, fraudType: obj.fraud_type, isLive },
    };
  }

  // ── Fallback: unknown Stripe event ──────────────────────────────────────────
  return {
    type:        'info',
    severity:    'low',
    title:       `${envTag} Stripe event: ${stripeType}`,
    description: `Received unhandled Stripe event of type "${stripeType}". Event ID: ${payload.id}`,
    metadata:    { stripeEventId: payload.id, stripeType, isLive },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DATADOG TRANSFORMER
// Docs: https://docs.datadoghq.com/integrations/webhooks/
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps Datadog monitor webhook payloads to canonical events.
 *
 * Datadog sends free-form POST bodies. Common fields:
 *   alert_status, alert_type, event_title, event_message,
 *   alert_id, monitor_id, tags, host
 */
function transformDatadog(payload, _headers) {
  const alertStatus = (payload.alert_status || payload.transition || '').toLowerCase();
  const alertType   = (payload.alert_type   || '').toLowerCase();
  const title       = payload.event_title   || payload.title   || 'Datadog alert';
  const message     = payload.event_message || payload.message || '';
  const host        = payload.host          || payload.hostname || 'unknown';
  const tags        = Array.isArray(payload.tags) ? payload.tags : (payload.tags || '').split(',').map((t) => t.trim()).filter(Boolean);

  // Derive severity from alert_status
  const severityMap = {
    alert:      'high',
    warning:    'medium',
    no_data:    'medium',
    renotify:   'medium',
    recovered:  'low',
    ok:         'low',
    resolved:   'low',
  };
  const severity = severityMap[alertStatus] || 'medium';

  // Derive type
  const typeMap = {
    alert:     'error',
    warning:   'warning',
    no_data:   'warning',
    recovered: 'info',
    ok:        'info',
    resolved:  'info',
  };
  const type = typeMap[alertStatus] || (alertType === 'error' ? 'error' : 'warning');

  return {
    type,
    severity,
    title:       truncate(title, MAX_TITLE),
    description: truncate(
      `Monitor: ${payload.monitor_id || 'unknown'}\nHost: ${host}\nStatus: ${alertStatus}\n${message}`,
      MAX_DESCRIPTION,
    ),
    metadata: {
      datadogAlertId:  payload.alert_id,
      datadogMonitorId: payload.monitor_id,
      alertStatus,
      alertType:       payload.alert_type,
      host,
      tags,
      org:             payload.org?.name || payload.org,
      url:             payload.url || payload.link,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC TRANSFORMER
// For any source that uses X-Webhook-Secret authentication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pass-through transformer for generic webhook senders.
 *
 * Expects the payload to already carry type/severity/title/description,
 * or falls back to safe defaults so the event is never dropped.
 */
function transformGeneric(payload, headers) {
  const VALID_TYPES      = ['error', 'warning', 'info', 'critical'];
  const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'];
  const sourceHint       = headers['x-source-name'] || headers['X-Source-Name'] || 'generic';

  return {
    type:        VALID_TYPES.includes(payload.type)           ? payload.type      : 'info',
    severity:    VALID_SEVERITIES.includes(payload.severity)  ? payload.severity  : 'medium',
    title:       truncate(payload.title || payload.name || `Event from ${sourceHint}`, MAX_TITLE),
    description: truncate(payload.description || payload.message || payload.body || '', MAX_DESCRIPTION),
    metadata: {
      sourceHint,
      originalType:     payload.type,
      originalSeverity: payload.severity,
      ...(payload.metadata   || {}),
      ...(payload.meta       || {}),
      ...(payload.attributes || {}),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSFORMER REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const TRANSFORMERS = {
  github:  transformGitHub,
  stripe:  transformStripe,
  datadog: transformDatadog,
  generic: transformGeneric,
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Enforce max-length constraints and attach the `source: 'webhook'` field.
 * Prevents transformer bugs from violating eventModel Joi limits.
 */
function sanitise(event, webhookSource) {
  return {
    source:      'webhook',
    type:        event.type        || 'info',
    severity:    event.severity    || 'medium',
    title:       truncate(event.title       || `Webhook event from ${webhookSource}`, MAX_TITLE),
    description: truncate(event.description || '', MAX_DESCRIPTION),
    metadata: {
      webhookSource,
      ...(event.metadata || {}),
    },
  };
}

/** Truncate a string to maxLen, appending "…" if cut. */
function truncate(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.length <= maxLen ? str : `${str.slice(0, maxLen - 1)}…`;
}

/** Format GitHub commits into a readable description block. */
function formatCommits(commits, compareUrl) {
  if (!Array.isArray(commits) || commits.length === 0) return compareUrl || '';
  const lines = commits.slice(0, 5).map((c) => `• ${c.id?.slice(0, 7)} ${truncate(c.message?.split('\n')[0] || '', 80)} (${c.author?.name})`);
  if (commits.length > 5) lines.push(`… and ${commits.length - 5} more`);
  if (compareUrl) lines.push(`\nCompare: ${compareUrl}`);
  return lines.join('\n');
}

/** Format a Stripe amount + currency into a human-readable string. */
function formatCurrency(amount, currency = 'usd') {
  if (typeof amount !== 'number') return 'unknown amount';
  const formatted = (amount / 100).toFixed(2);
  return `${currency.toUpperCase()} ${formatted}`;
}

/** Generate a fallback idempotency key when no provider ID is available. */
function fallbackKey(payload) {
  // Use a hash of a stable subset of the payload
  const stable = JSON.stringify({ t: payload.type, ts: payload.created || payload.timestamp || Date.now() });
  let h = 0;
  for (let i = 0; i < stable.length; i++) {
    h = Math.imul(31, h) + stable.charCodeAt(i) | 0;
  }
  return Math.abs(h).toString(16);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  SUPPORTED_SOURCES,
  transform,
  deriveIdempotencyKey,
  extractSourceTimestamp,
};
