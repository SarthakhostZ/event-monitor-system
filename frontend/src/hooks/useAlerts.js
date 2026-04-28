import { useState, useEffect, useCallback } from 'react';
import { listAlerts } from '../api/alerts';
import { POLL_INTERVAL_MS } from '../utils/constants';

export default function useAlerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState('loading');
  const [error, setError] = useState(null);

  const fetchAlerts = useCallback(async (isFirst = false) => {
    if (!isFirst) setLoading('refreshing');
    try {
      const data = await listAlerts();
      setAlerts(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load alerts');
    } finally {
      setLoading('idle');
    }
  }, []);

  useEffect(() => {
    setLoading('loading');
    fetchAlerts(true);
    const id = setInterval(() => fetchAlerts(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchAlerts]);

  return { alerts, loading, error, refetch: fetchAlerts };
}
