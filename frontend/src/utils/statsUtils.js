import { getLast24HourBuckets, formatHourLabel, isWithin24Hours } from './dateUtils';
import { SEVERITY_COLORS } from './constants';
import { parseISO } from 'date-fns';

export function deriveStats(events, alerts) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const midpoint = cutoff + 12 * 60 * 60 * 1000;

  const events24h = events.filter(e => {
    try {
      const t = typeof e.timestamp === 'string' ? parseISO(e.timestamp) : new Date(e.timestamp);
      return t.getTime() >= cutoff;
    } catch {
      return false;
    }
  });

  const firstHalf = events24h.filter(e => {
    try {
      const t = typeof e.timestamp === 'string' ? parseISO(e.timestamp) : new Date(e.timestamp);
      return t.getTime() < midpoint;
    } catch {
      return false;
    }
  }).length;
  const secondHalf = events24h.length - firstHalf;
  const trend = secondHalf > firstHalf ? 'up' : secondHalf < firstHalf ? 'down' : 'neutral';

  const criticalCount = events24h.filter(e => e.severity === 'critical').length;

  const totalAlerts = alerts.length;
  const resolvedAlerts = alerts.filter(a => a.status === 'resolved').length;
  const successRate = totalAlerts > 0 ? Math.round((resolvedAlerts / totalAlerts) * 100) : 0;

  const resolvedWithTime = alerts.filter(
    a => a.status === 'resolved' && a.createdAt && a.resolvedAt
  );
  let avgResponseTime = null;
  if (resolvedWithTime.length > 0) {
    const totalMs = resolvedWithTime.reduce((sum, a) => {
      const created = typeof a.createdAt === 'string' ? parseISO(a.createdAt) : new Date(a.createdAt);
      const resolved = typeof a.resolvedAt === 'string' ? parseISO(a.resolvedAt) : new Date(a.resolvedAt);
      return sum + (resolved.getTime() - created.getTime());
    }, 0);
    avgResponseTime = Math.round(totalMs / resolvedWithTime.length / 60_000);
  }

  return {
    totalEvents24h: events24h.length,
    trend,
    criticalCount,
    totalAlerts,
    successRate,
    avgResponseTime,
  };
}

export function buildTimelineBuckets(events) {
  const buckets = getLast24HourBuckets().map(d => ({
    hour: formatHourLabel(d),
    epochHour: d.getTime(),
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  }));

  const cutoff = buckets[0].epochHour;

  events.forEach(e => {
    try {
      const t = typeof e.timestamp === 'string' ? parseISO(e.timestamp) : new Date(e.timestamp);
      const ms = t.getTime();
      if (ms < cutoff) return;

      // Find which bucket this event belongs to
      for (let i = buckets.length - 1; i >= 0; i--) {
        if (ms >= buckets[i].epochHour) {
          const sev = e.severity;
          if (sev in buckets[i]) buckets[i][sev]++;
          break;
        }
      }
    } catch {
      // skip malformed
    }
  });

  return buckets.map(({ hour, low, medium, high, critical }) => ({
    hour, low, medium, high, critical,
  }));
}

export function groupBySource(events) {
  const counts = {};
  events.forEach(e => {
    if (e.source) counts[e.source] = (counts[e.source] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

export function groupBySeverity(events) {
  const counts = { low: 0, medium: 0, high: 0, critical: 0 };
  events.forEach(e => {
    if (e.severity in counts) counts[e.severity]++;
  });
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => ({ name, value, color: SEVERITY_COLORS[name] }));
}
