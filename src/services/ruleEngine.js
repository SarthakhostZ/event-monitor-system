'use strict';

/**
 * ruleEngine — configurable rule-based event classification
 *
 * Rules are loaded from src/config/rules.json.  No code changes are needed
 * to add, edit, or reprioritise rules — edit the JSON file and redeploy.
 *
 * Rule evaluation order
 * ─────────────────────
 * Rules are sorted ascending by `priority` (1 = highest).  The first rule
 * whose condition matches is applied and evaluation stops.  If no rule
 * matches, the defaults block from rules.json is used.
 *
 * Condition structure
 * ───────────────────
 * {
 *   "field":    "metadata.count",   // dot-path into the event object
 *   "operator": "greaterThan",      // equals|contains|greaterThan|lessThan|regex|exists
 *   "value":    50,                 // compared value (not used by "exists")
 *   "and":      { <condition> },    // optional — both must be true
 *   "or":       { <condition> }     // optional — at least one must be true
 * }
 *
 * Supported operators
 * ───────────────────
 *   equals       strict equality (===)
 *   contains     substring match (string) or element membership (array)
 *   greaterThan  numeric >
 *   lessThan     numeric <
 *   regex        RegExp test against string value
 *   exists       field is present and not null/undefined
 */

const path   = require('path');
const rules  = require(path.join(__dirname, '../config/rules.json'));
const db     = require('./dynamodb');
const config = require('../config');
const logger = require('../utils/logger');

// How many times higher than baseline triggers a frequency anomaly.
const ANOMALY_MULTIPLIER = 3;
// Number of past hours used to build the baseline average.
const BASELINE_WINDOW_HOURS = 24;

// Sort rules once at module load — avoids re-sorting per invocation.
const sortedRules = [...rules.rules].sort((a, b) => a.priority - b.priority);
const { defaults } = rules;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate all rules against an event and return the first matching action.
 *
 * @param {object} event - Plain event object (output of validateEvent or SQS body)
 * @returns {{
 *   severity:     string,   // 'low' | 'medium' | 'high' | 'critical'
 *   triggerAlert: boolean,
 *   matchedRuleId: string|null
 * }}
 *
 * @example
 * const result = applyRules({ type: 'error', metadata: { count: 80 } });
 * // → { severity: 'high', triggerAlert: true, matchedRuleId: 'high-error-rate' }
 */
function applyRules(event) {
  for (const rule of sortedRules) {
    if (evaluateCondition(rule.condition, event)) {
      return {
        severity:     rule.action.setSeverity,
        triggerAlert: rule.action.triggerAlert ?? false,
        matchedRuleId: rule.id,
      };
    }
  }

  // No rule matched — use JSON defaults, but preserve the incoming severity
  // if it is already more specific than the default.
  return {
    severity:     event.severity || defaults.severity,
    triggerAlert: defaults.triggerAlert,
    matchedRuleId: null,
  };
}

/**
 * Return every rule that would match the event (useful for testing / debug).
 *
 * @param {object} event
 * @returns {Array<{ id: string, priority: number, action: object }>}
 */
function matchingRules(event) {
  return sortedRules
    .filter((rule) => evaluateCondition(rule.condition, event))
    .map(({ id, priority, action }) => ({ id, priority, action }));
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION EVALUATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively evaluate a condition object against an event.
 *
 * @param {object} condition
 * @param {object} event
 * @returns {boolean}
 */
function evaluateCondition(condition, event) {
  // Evaluate the base predicate for this condition node.
  let result = applyOperator(condition.operator, getField(event, condition.field), condition.value);

  // Chain AND: both the current node AND the sub-condition must be true.
  if (condition.and !== undefined) {
    result = result && evaluateCondition(condition.and, event);
  }

  // Chain OR: the current node OR the sub-condition being true is sufficient.
  if (condition.or !== undefined) {
    result = result || evaluateCondition(condition.or, event);
  }

  return result;
}

/**
 * Apply a single operator to a field value and a comparison target.
 *
 * @param {string} operator
 * @param {*}      fieldValue - Current value of the event field
 * @param {*}      target     - Value from the rule definition
 * @returns {boolean}
 */
function applyOperator(operator, fieldValue, target) {
  switch (operator) {
    case 'equals':
      return fieldValue === target;

    case 'contains':
      if (typeof fieldValue === 'string') {
        return fieldValue.toLowerCase().includes(String(target).toLowerCase());
      }
      if (Array.isArray(fieldValue)) {
        return fieldValue.includes(target);
      }
      return false;

    case 'greaterThan':
      return typeof fieldValue === 'number' && fieldValue > target;

    case 'lessThan':
      return typeof fieldValue === 'number' && fieldValue < target;

    case 'regex': {
      if (typeof fieldValue !== 'string') return false;
      try {
        return new RegExp(target).test(fieldValue);
      } catch {
        return false;   // invalid regex in rules.json — fail safe
      }
    }

    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;

    default:
      // Unknown operator — log-safe: returns false so processing continues.
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD ACCESS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely read a dot-path from an object.
 * Returns undefined if any segment along the path is missing.
 *
 * @param {object} obj
 * @param {string} dotPath - e.g. "metadata.count" or "type"
 * @returns {*}
 *
 * @example
 * getField({ metadata: { count: 80 } }, 'metadata.count')  // → 80
 * getField({ type: 'error' }, 'metadata.count')             // → undefined
 */
function getField(obj, dotPath) {
  return dotPath.split('.').reduce((current, key) => current?.[key], obj);
}

// ─────────────────────────────────────────────────────────────────────────────
// EVALUATE RULES  (standard interface used by eventProcessor and tests)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Evaluate all rules against an event.
 *
 * Severity and shouldAlert are set by the FIRST matching rule (priority order).
 * matchedRules contains ALL rule IDs whose conditions matched — useful for
 * audit logging and debugging.
 *
 * @param {object} event
 * @returns {{
 *   severity:     string,    // 'low' | 'medium' | 'high' | 'critical'
 *   shouldAlert:  boolean,
 *   matchedRules: string[]   // ids of every rule whose condition matched
 * }}
 */
function evaluateRules(event) {
  let severity    = defaults.severity;
  let shouldAlert = defaults.triggerAlert;
  const matchedRules = [];

  for (const rule of sortedRules) {
    try {
      if (evaluateCondition(rule.condition, event)) {
        // Collect every matching rule id for the audit trail.
        matchedRules.push(rule.id);

        // Only the FIRST match sets the action (highest priority).
        if (matchedRules.length === 1) {
          severity    = rule.action.setSeverity ?? severity;
          shouldAlert = rule.action.triggerAlert ?? shouldAlert;
        }
      }
    } catch (err) {
      logger.error('ruleEngine: error evaluating rule', {
        ruleId: rule.id,
        error:  err.message,
      });
    }
  }

  logger.debug('ruleEngine: evaluateRules complete', { matchedRules, severity, shouldAlert });
  return { severity, shouldAlert, matchedRules };
}

// ─────────────────────────────────────────────────────────────────────────────
// FREQUENCY-BASED ANOMALY DETECTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the MetricsTable key for a given event type and Date.
 * Format: "events_by_type:<type>:<YYYY-MM-DDTHH>"  (hourly granularity)
 *
 * @param {string} eventType
 * @param {Date}   date
 * @returns {string}
 */
function _buildHourKey(eventType, date) {
  return `events_by_type:${eventType}:${date.toISOString().slice(0, 13)}`;
}

/**
 * Query the MetricsTable for the counter value of a single hourly key.
 * Returns 0 when no record exists or the query fails.
 *
 * @param {string} hourKey
 * @returns {Promise<number>}
 */
async function _fetchHourCount(hourKey) {
  try {
    const { items } = await db.query(config.dynamodb.metricsTable, {
      KeyConditionExpression:    'metricKey = :mk',
      ExpressionAttributeValues: { ':mk': hourKey },
      Limit: 1,
    });
    return items.length > 0 ? Number(items[0].value) : 0;
  } catch (err) {
    // A single DB hiccup must not generate false anomalies or stall processing.
    logger.warn('ruleEngine: could not fetch metric', { hourKey, error: err.message });
    return 0;
  }
}

/**
 * Detect whether the current-hour event count is anomalously high compared
 * with the same event type over the past BASELINE_WINDOW_HOURS hours.
 *
 * Anomaly threshold: currentCount >= ANOMALY_MULTIPLIER × baselineAvg
 * Only hours that recorded at least one event are included in the average
 * (empty hours would dilute the baseline and trigger false positives).
 *
 * @param {object} event  Must have a `type` string field.
 * @returns {Promise<{
 *   isAnomaly:   boolean,
 *   currentCount: number,
 *   baselineAvg:  number,
 *   multiplier:   number
 * }>}
 */
async function checkFrequencyAnomaly(event) {
  const now = new Date();

  try {
    const currentCount = await _fetchHourCount(_buildHourKey(event.type, now));

    // Fetch the past BASELINE_WINDOW_HOURS hourly buckets in parallel.
    const baselinePromises = [];
    for (let h = 1; h <= BASELINE_WINDOW_HOURS; h++) {
      const past = new Date(now.getTime() - h * 3_600_000);
      baselinePromises.push(_fetchHourCount(_buildHourKey(event.type, past)));
    }
    const baselineCounts = (await Promise.all(baselinePromises)).filter(v => v > 0);

    if (baselineCounts.length === 0) {
      logger.debug('ruleEngine: no baseline data for frequency check', { eventType: event.type });
      return { isAnomaly: false, currentCount, baselineAvg: 0, multiplier: 0 };
    }

    const baselineAvg = baselineCounts.reduce((s, v) => s + v, 0) / baselineCounts.length;
    const multiplier  = baselineAvg > 0 ? currentCount / baselineAvg : 0;
    const isAnomaly   = multiplier >= ANOMALY_MULTIPLIER;

    logger.debug('ruleEngine: frequency anomaly check', {
      eventType:   event.type,
      currentCount,
      baselineAvg: +baselineAvg.toFixed(2),
      multiplier:  +multiplier.toFixed(2),
      isAnomaly,
    });

    return {
      isAnomaly,
      currentCount,
      baselineAvg: +baselineAvg.toFixed(2),
      multiplier:  +multiplier.toFixed(2),
    };
  } catch (err) {
    logger.error('ruleEngine: checkFrequencyAnomaly failed', { error: err.message });
    return { isAnomaly: false, currentCount: 0, baselineAvg: 0, multiplier: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  // Primary interface
  evaluateRules,
  checkFrequencyAnomaly,

  // Legacy / secondary interface (kept for backward-compat)
  applyRules,
  matchingRules,

  // Exposed for unit testing — not part of the public handler contract.
  _evaluateCondition: evaluateCondition,
  _applyOperator:     applyOperator,
  _getField:          getField,
  _buildHourKey,
};
