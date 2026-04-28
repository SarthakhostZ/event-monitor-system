import { formatDistanceToNow, format, parseISO } from 'date-fns';

export function formatRelative(dateStr) {
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : new Date(dateStr);
    return formatDistanceToNow(date, { addSuffix: true });
  } catch {
    return 'Unknown time';
  }
}

export function formatTimestamp(dateStr) {
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : new Date(dateStr);
    return format(date, 'MMM d, HH:mm:ss');
  } catch {
    return 'Invalid date';
  }
}

export function formatHourLabel(date) {
  return format(date, 'HH:00');
}

// Returns an array of 24 Date objects representing the start of each hour
// from 23 hours ago up to the current hour
export function getLast24HourBuckets() {
  const now = new Date();
  const buckets = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(now.getHours() - i, 0, 0, 0);
    buckets.push(d);
  }
  return buckets;
}

export function isWithin24Hours(dateStr) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const date = typeof dateStr === 'string' ? parseISO(dateStr) : new Date(dateStr);
    return date.getTime() >= cutoff;
  } catch {
    return false;
  }
}
