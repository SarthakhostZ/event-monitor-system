export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
export const APP_NAME = import.meta.env.VITE_APP_NAME || 'Event Monitor System';
export const POLL_INTERVAL_MS = Number(import.meta.env.VITE_POLL_INTERVAL_MS) || 30_000;
export const HEALTH_POLL_INTERVAL_MS = Number(import.meta.env.VITE_HEALTH_POLL_INTERVAL_MS) || 60_000;
export const TOKEN_KEY = 'ems_token';
export const UNAUTHORIZED_EVENT = 'ems:unauthorized';

export const SEVERITY_COLORS = {
  low: '#22c55e',
  medium: '#f59e0b',
  high: '#f97316',
  critical: '#ef4444',
};

export const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

export const SEVERITY_BADGE_CLASSES = {
  low: 'bg-green-900 text-green-300',
  medium: 'bg-amber-900 text-amber-300',
  high: 'bg-orange-900 text-orange-300',
  critical: 'bg-red-900 text-red-300 animate-pulse',
};
