'use strict';

/**
 * emailService — Nodemailer-based email delivery for the event monitoring system.
 *
 * Public API:
 *   sendAlert(event, analysis)    — rich HTML alert email built from alertEmail.html template
 *   sendDigest(events, prevEvents) — daily digest summarising events by severity + top 5 critical
 *   sendAlertEmail(eventData)     — backward-compat wrapper used by alertDispatcher
 *
 * Design notes:
 *   - Single pooled transporter is created once and reused across warm Lambda invocations.
 *   - Works with both generic SMTP and AWS SES SMTP endpoint — no SDK changes needed.
 *   - All user-supplied values are HTML-escaped before template substitution (XSS prevention).
 *   - Recipient address is validated before every send; invalid recipients throw synchronously.
 *   - Template uses {{VAR}} placeholders and {{#BOOL}}...{{/BOOL}} conditional blocks.
 */

const fs      = require('fs');
const path    = require('path');
const nodemailer = require('nodemailer');
const config  = require('../config');
const logger  = require('../utils/logger');

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_STYLES = {
  critical: { bg: '#dc2626', text: '#ffffff', label: 'CRITICAL' },
  high:     { bg: '#ea580c', text: '#ffffff', label: 'HIGH'     },
  medium:   { bg: '#d97706', text: '#ffffff', label: 'MEDIUM'   },
  low:      { bg: '#16a34a', text: '#ffffff', label: 'LOW'      },
};

const DEFAULT_STYLE = { bg: '#6b7280', text: '#ffffff', label: 'UNKNOWN' };

// RFC 5322 simplified — adequate for operational validation at service boundaries.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION POOL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Module-level pooled transporter, reused across warm Lambda invocations.
 * Reset to null when config changes (test environments only).
 *
 * Nodemailer pool settings:
 *   maxConnections — concurrent SMTP connections (5 covers most burst needs)
 *   maxMessages    — messages per connection before re-connecting (100)
 *   rateLimit      — cap at 14 msg/s to stay within SES send rate defaults
 */
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  if (!config.email.host) {
    return null;  // SMTP not configured; callers check for null.
  }

  _transporter = nodemailer.createTransport({
    host:   config.email.host,
    port:   config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
    // Connection pooling — keep connections alive between Lambda invocations.
    pool:           true,
    maxConnections: 5,
    maxMessages:    100,
    rateLimit:      14,    // messages per second
    // Reconnect on connection errors rather than failing permanently.
    socketTimeout:  30_000,
    greetingTimeout: 15_000,
  });

  logger.info('emailService: SMTP transporter created (pooled)', {
    host:   config.email.host,
    port:   config.email.port,
    secure: config.email.secure,
    isSES:  config.email.host.includes('amazonaws.com'),
  });

  return _transporter;
}

// Exposed for test teardown only.
function _resetTransporter() {
  if (_transporter) {
    _transporter.close();
    _transporter = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE ENGINE
// ─────────────────────────────────────────────────────────────────────────────

let _alertTemplate = null;

function loadAlertTemplate() {
  if (_alertTemplate) return _alertTemplate;
  const tplPath = path.join(__dirname, '../templates/alertEmail.html');
  _alertTemplate = fs.readFileSync(tplPath, 'utf8');
  return _alertTemplate;
}

/**
 * Lightweight template renderer.
 *
 * Supported syntax:
 *   {{VAR}}               — replace with data[VAR] (value must already be HTML-escaped)
 *   {{#BOOL}}...{{/BOOL}} — include block only when data[BOOL] is truthy; nested {{VAR}} ok
 *
 * @param {string} template
 * @param {object} data     — all string values must be pre-escaped (use esc() before passing)
 * @returns {string}
 */
function renderTemplate(template, data) {
  // Process conditional blocks first.
  const withConditionals = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_, key, content) => (data[key] ? content : ''),
  );

  // Replace remaining scalar placeholders.
  return withConditionals.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => (data[key] !== undefined ? String(data[key]) : ''),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — sendAlert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a rich HTML alert email using the alertEmail.html template.
 *
 * @param {object} event
 * @param {string} event.eventId
 * @param {string} event.title
 * @param {string} [event.description]
 * @param {string} event.severity        — critical | high | medium | low
 * @param {string} [event.type]
 * @param {string} [event.source]
 * @param {string} [event.timestamp]     — ISO 8601
 * @param {object} [event.metadata]
 * @param {string} [event.analyzedBy]    — "ai" | "rule-engine"
 *
 * @param {object} [analysis]            — AI analysis result; may be empty
 * @param {string} [analysis.aiSummary]
 * @param {string} [analysis.aiRecommendation]
 * @param {string} [analysis.aiRootCause]
 * @param {number} [analysis.confidence] — 0–1 float
 * @param {string} [analysis.analyzedBy]
 *
 * @returns {Promise<{ messageId: string|null, skipped?: boolean }>}
 * @throws  {Error} When recipient is invalid or SMTP delivery fails.
 */
async function sendAlert(event, analysis = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('emailService.sendAlert: SMTP not configured — skipping', {
      eventId: event.eventId,
    });
    return { messageId: null, skipped: true };
  }

  const to = config.email.alertTo;
  validateEmail(to, 'recipient (ALERT_EMAIL_TO)');

  const style    = SEVERITY_STYLES[event.severity] ?? DEFAULT_STYLE;
  const dashUrl  = process.env.DASHBOARD_URL || '#';
  const eventDate = formatDate(event.timestamp);

  // Merge flat eventData fields with explicit analysis arg (analysis takes precedence).
  const aiSummary        = analysis.aiSummary        || event.aiSummary        || '';
  const aiRecommendation = analysis.aiRecommendation || event.aiRecommendation || '';
  const aiRootCause      = analysis.aiRootCause      || event.aiRootCause      || '';
  const analyzedBy       = analysis.analyzedBy       || event.analyzedBy       || 'rule-engine';
  const rawConfidence    = analysis.confidence       ?? event.aiConfidence     ?? null;
  const confidenceStr    = rawConfidence != null
    ? `${Math.round(rawConfidence * 100)}%`
    : '';

  const hasAI      = Boolean(aiSummary);
  const metadata   = event.metadata && typeof event.metadata === 'object' ? event.metadata : {};
  const metadataRows = buildMetadataRows(metadata);

  const subject = `[${style.label}] ${event.title || 'Alert'} — ${event.eventId}`;

  const templateData = {
    // Severity theming
    SEVERITY_BG:    esc(style.bg),
    SEVERITY_TEXT:  esc(style.text),
    SEVERITY_LABEL: esc(style.label),
    // Event fields
    EVENT_TITLE:       esc(event.title || 'Event Alert'),
    EVENT_ID:          esc(event.eventId || ''),
    EVENT_TYPE:        esc(event.type   || '—'),
    EVENT_SOURCE:      esc(event.source || '—'),
    EVENT_DATE:        esc(eventDate),
    EVENT_DESCRIPTION: esc(event.description || ''),
    // AI analysis fields
    AI_SUMMARY:        esc(aiSummary),
    AI_ROOT_CAUSE:     esc(aiRootCause),
    AI_RECOMMENDATION: esc(aiRecommendation),
    AI_CONFIDENCE:     esc(confidenceStr),
    ANALYZED_BY:       esc(analyzedBy),
    // Metadata rows already contain escaped HTML — injected raw.
    METADATA_ROWS:     metadataRows,
    // Links
    DASHBOARD_URL:       esc(dashUrl),
    EVENT_DASHBOARD_URL: esc(`${dashUrl}/events/${event.eventId || ''}`),
    UNSUBSCRIBE_URL:     esc(`${dashUrl}/unsubscribe`),
    // Conditional flags (truthy = render the block)
    HAS_DESCRIPTION:    event.description ? '1' : '',
    HAS_AI:             hasAI ? '1' : '',
    NO_AI:              hasAI ? '' : '1',
    HAS_ROOT_CAUSE:     aiRootCause ? '1' : '',
    HAS_RECOMMENDATION: aiRecommendation ? '1' : '',
    HAS_METADATA:       metadataRows ? '1' : '',
    HAS_CONFIDENCE:     confidenceStr ? '1' : '',
  };

  const html = renderTemplate(loadAlertTemplate(), templateData);

  const info = await transporter.sendMail({
    from:    config.email.from,
    to,
    subject,
    html,
  });

  logger.info('emailService.sendAlert: email sent', {
    eventId:   event.eventId,
    severity:  event.severity,
    messageId: info.messageId,
    to,
  });

  return { messageId: info.messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — sendDigest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a daily digest email summarising a batch of events.
 *
 * @param {object[]} events          — today's events
 * @param {object[]} [previousEvents] — yesterday's events for trend comparison
 * @param {object}  [opts]
 * @param {string}  [opts.to]        — override recipient (defaults to config.email.alertTo)
 * @param {string}  [opts.date]      — ISO date string for the digest header (defaults to today)
 *
 * @returns {Promise<{ messageId: string|null, skipped?: boolean }>}
 * @throws  {Error} When recipient is invalid or SMTP delivery fails.
 */
async function sendDigest(events = [], previousEvents = [], opts = {}) {
  const transporter = getTransporter();
  if (!transporter) {
    logger.warn('emailService.sendDigest: SMTP not configured — skipping');
    return { messageId: null, skipped: true };
  }

  const to = opts.to || config.email.alertTo;
  validateEmail(to, 'recipient (ALERT_EMAIL_TO)');

  const dateLabel = opts.date
    ? new Date(opts.date).toDateString()
    : new Date().toDateString();

  // Tally counts by severity.
  const countsBySeverity = tallyBySeverity(events);
  const prevCounts       = tallyBySeverity(previousEvents);
  const totalToday       = events.length;
  const totalYesterday   = previousEvents.length;

  // Top 5 critical/high events for the spotlight section.
  const top5 = [...events]
    .filter(e => e.severity === 'critical' || e.severity === 'high')
    .sort((a, b) => {
      const order = { critical: 0, high: 1 };
      return (order[a.severity] ?? 2) - (order[b.severity] ?? 2);
    })
    .slice(0, 5);

  const subject = `[Digest] Event Monitor Daily Summary — ${dateLabel}`;
  const html    = buildDigestHtml({
    dateLabel,
    countsBySeverity,
    prevCounts,
    totalToday,
    totalYesterday,
    top5,
  });

  const info = await transporter.sendMail({
    from:    config.email.from,
    to,
    subject,
    html,
  });

  logger.info('emailService.sendDigest: digest sent', {
    totalEvents: totalToday,
    critical:    countsBySeverity.critical,
    high:        countsBySeverity.high,
    messageId:   info.messageId,
    to,
  });

  return { messageId: info.messageId };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — sendAlertEmail  (backward-compat for alertDispatcher)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Backward-compatible wrapper used by alertDispatcher.
 * Splits the flat SNS eventData object into (event, analysis) and delegates to sendAlert.
 *
 * @param {object} eventData — flat SNS message body from eventAnalyzer
 * @returns {Promise<{ messageId: string|null, skipped?: boolean }>}
 */
async function sendAlertEmail(eventData) {
  const analysis = {
    aiSummary:        eventData.aiSummary,
    aiRecommendation: eventData.aiRecommendation,
    aiRootCause:      eventData.aiRootCause,
    confidence:       eventData.aiConfidence,
    analyzedBy:       eventData.analyzedBy,
  };
  return sendAlert(eventData, analysis);
}

// ─────────────────────────────────────────────────────────────────────────────
// DIGEST HTML BUILDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the inline HTML for the daily digest email.
 * Intentionally kept as a self-contained function (no separate template file)
 * so it can be adjusted without touching the alert template.
 *
 * @param {object} opts
 * @param {string}   opts.dateLabel
 * @param {object}   opts.countsBySeverity   — { critical, high, medium, low }
 * @param {object}   opts.prevCounts         — previous period counts (same shape)
 * @param {number}   opts.totalToday
 * @param {number}   opts.totalYesterday
 * @param {object[]} opts.top5               — up to 5 critical/high event objects
 * @returns {string}
 */
function buildDigestHtml({ dateLabel, countsBySeverity, prevCounts, totalToday, totalYesterday, top5 }) {
  const dashUrl     = process.env.DASHBOARD_URL || '#';
  const trendSymbol = totalYesterday === 0
    ? ''
    : totalToday > totalYesterday
      ? '&#8679;'   // ⇧ up
      : totalToday < totalYesterday
        ? '&#8681;' // ⇩ down
        : '&#8680;'; // ⇨ flat

  const trendColor = totalToday > totalYesterday
    ? '#dc2626'
    : totalToday < totalYesterday
      ? '#16a34a'
      : '#6b7280';

  const trendPct = totalYesterday > 0
    ? `${Math.abs(Math.round(((totalToday - totalYesterday) / totalYesterday) * 100))}%`
    : null;

  const severityRows = ['critical', 'high', 'medium', 'low'].map(sev => {
    const style  = SEVERITY_STYLES[sev];
    const today  = countsBySeverity[sev] || 0;
    const prev   = prevCounts[sev] || 0;
    const delta  = today - prev;
    const deltaHtml = totalYesterday > 0 && delta !== 0
      ? `<span style="font-size:11px;color:${delta > 0 ? '#dc2626' : '#16a34a'};margin-left:6px;">
           ${delta > 0 ? '+' : ''}${delta}
         </span>`
      : '';

    return `
      <tr>
        <td style="padding:10px 16px;vertical-align:middle;">
          <span style="display:inline-block;padding:3px 12px;background:${esc(style.bg)};
                       color:${esc(style.text)};border-radius:12px;font-size:12px;font-weight:700;">
            ${esc(style.label)}
          </span>
        </td>
        <td style="padding:10px 16px;font-size:22px;font-weight:700;color:#111827;text-align:right;">
          ${today}${deltaHtml}
        </td>
      </tr>`;
  }).join('');

  const top5Rows = top5.length > 0
    ? top5.map((ev, i) => {
        const s = SEVERITY_STYLES[ev.severity] ?? DEFAULT_STYLE;
        return `
          <tr style="${i % 2 === 1 ? 'background:#f9fafb;' : ''}">
            <td style="padding:9px 14px;font-size:12px;color:#6b7280;font-family:monospace,monospace;
                       border-bottom:1px solid #f3f4f6;white-space:nowrap;">
              ${esc((ev.eventId || '').slice(0, 8))}…
            </td>
            <td style="padding:9px 14px;font-size:13px;color:#374151;border-bottom:1px solid #f3f4f6;">
              ${esc(ev.title || '—')}
            </td>
            <td style="padding:9px 14px;border-bottom:1px solid #f3f4f6;text-align:center;">
              <span style="display:inline-block;padding:2px 9px;background:${esc(s.bg)};
                           color:${esc(s.text)};border-radius:10px;font-size:11px;font-weight:700;">
                ${esc(s.label)}
              </span>
            </td>
            <td style="padding:9px 14px;font-size:11px;color:#9ca3af;border-bottom:1px solid #f3f4f6;
                       white-space:nowrap;">
              ${esc(formatDate(ev.timestamp))}
            </td>
          </tr>`;
      }).join('')
    : `<tr>
         <td colspan="4" style="padding:20px 16px;text-align:center;font-size:13px;color:#9ca3af;font-style:italic;">
           No critical or high-severity events today.
         </td>
       </tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Event Monitor Daily Digest</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#f3f4f6;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;
                      box-shadow:0 1px 3px rgba(0,0,0,.12);">

          <!-- Header -->
          <tr>
            <td style="background:#1e293b;padding:24px 32px;">
              <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.1em;
                         text-transform:uppercase;color:#94a3b8;">
                Event Monitor System &mdash; Daily Digest
              </p>
              <h1 style="margin:0;font-size:20px;font-weight:700;color:#f8fafc;line-height:1.3;">
                ${esc(dateLabel)}
              </h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:28px 32px;">

              <!-- Totals banner -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border-radius:8px;background:#f1f5f9;margin-bottom:28px;overflow:hidden;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px;font-size:12px;font-weight:600;text-transform:uppercase;
                               letter-spacing:.08em;color:#64748b;">
                      Total Events
                    </p>
                    <p style="margin:0;font-size:40px;font-weight:700;color:#0f172a;line-height:1.1;">
                      ${totalToday}
                      ${trendSymbol
                        ? `<span style="font-size:20px;color:${esc(trendColor)};margin-left:8px;">
                             ${trendSymbol}${trendPct ? ` ${esc(trendPct)}` : ''}
                           </span>`
                        : ''}
                    </p>
                    ${totalYesterday > 0
                      ? `<p style="margin:6px 0 0;font-size:12px;color:#94a3b8;">
                           vs ${totalYesterday} yesterday
                         </p>`
                      : ''}
                  </td>
                </tr>
              </table>

              <!-- Breakdown by severity -->
              <h2 style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;
                         letter-spacing:.1em;color:#9ca3af;">
                Events by Severity
              </h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border:1px solid #e5e7eb;border-radius:6px;border-collapse:separate;
                            overflow:hidden;margin-bottom:28px;">
                ${severityRows}
              </table>

              <!-- Top 5 critical events -->
              <h2 style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;
                         letter-spacing:.1em;color:#9ca3af;">
                Top Critical &amp; High Events
              </h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                     style="border:1px solid #e5e7eb;border-radius:6px;border-collapse:separate;
                            overflow:hidden;margin-bottom:28px;">
                <tr style="background:#f9fafb;">
                  <th style="padding:8px 14px;font-size:11px;font-weight:700;text-transform:uppercase;
                              letter-spacing:.06em;color:#6b7280;text-align:left;border-bottom:1px solid #e5e7eb;">
                    ID
                  </th>
                  <th style="padding:8px 14px;font-size:11px;font-weight:700;text-transform:uppercase;
                              letter-spacing:.06em;color:#6b7280;text-align:left;border-bottom:1px solid #e5e7eb;">
                    Title
                  </th>
                  <th style="padding:8px 14px;font-size:11px;font-weight:700;text-transform:uppercase;
                              letter-spacing:.06em;color:#6b7280;text-align:center;border-bottom:1px solid #e5e7eb;">
                    Severity
                  </th>
                  <th style="padding:8px 14px;font-size:11px;font-weight:700;text-transform:uppercase;
                              letter-spacing:.06em;color:#6b7280;text-align:left;border-bottom:1px solid #e5e7eb;">
                    Time
                  </th>
                </tr>
                ${top5Rows}
              </table>

              <!-- CTA -->
              <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <a href="${esc(dashUrl)}"
                       style="display:inline-block;padding:11px 24px;background:#1e293b;color:#f8fafc;
                              text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">
                      View Full Dashboard &rarr;
                    </a>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:16px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
              <p style="margin:0 0 5px;font-size:12px;color:#9ca3af;line-height:1.5;">
                This digest was generated by <strong style="color:#6b7280;">Event Monitor System</strong>.
              </p>
              <p style="margin:0;font-size:12px;color:#9ca3af;">
                <a href="${esc(dashUrl)}" style="color:#6b7280;text-decoration:underline;">Dashboard</a>
                &nbsp;&middot;&nbsp;
                <a href="${esc(dashUrl)}/unsubscribe" style="color:#6b7280;text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HTML-escape a value for safe injection into HTML attributes and text nodes.
 * @param {*} str
 * @returns {string}
 */
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/**
 * Format an ISO timestamp to a human-readable UTC string.
 * @param {string} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toUTCString();
  } catch {
    return String(iso);
  }
}

/**
 * Build escaped <tr> rows for the metadata table.
 * Returns an empty string when metadata has no own keys.
 *
 * @param {object} metadata
 * @returns {string}  Safe HTML string
 */
function buildMetadataRows(metadata) {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return '';

  return entries
    .map(([k, v], i) => `
      <tr${i % 2 === 1 ? ' style="background:#f9fafb;"' : ''}>
        <td style="padding:8px 14px;font-size:12px;font-weight:600;color:#374151;
                   white-space:nowrap;border-bottom:1px solid #f3f4f6;">
          ${esc(String(k))}
        </td>
        <td style="padding:8px 14px;font-size:12px;color:#4b5563;border-bottom:1px solid #f3f4f6;
                   word-break:break-word;">
          ${esc(String(v))}
        </td>
      </tr>`)
    .join('');
}

/**
 * Count events by severity level.
 * @param {object[]} events
 * @returns {{ critical: number, high: number, medium: number, low: number }}
 */
function tallyBySeverity(events) {
  return events.reduce(
    (acc, ev) => {
      const sev = ev.severity;
      if (sev in acc) acc[sev]++;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 },
  );
}

/**
 * Validate an email address and throw if invalid.
 * @param {string} address
 * @param {string} label    — used in the error message for context
 * @throws {Error}
 */
function validateEmail(address, label = 'email address') {
  if (typeof address !== 'string' || !EMAIL_RE.test(address.trim())) {
    throw new Error(`emailService: invalid ${label}: "${address}"`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  sendAlert,
  sendDigest,
  sendAlertEmail,
  // Internal — exposed for testing only.
  _resetTransporter,
};
