import { useState, useEffect, useRef, useCallback } from 'react';
import { listEvents } from '../api/events';
import { POLL_INTERVAL_MS } from '../utils/constants';

export default function useEvents() {
  const [events, setEvents] = useState([]);
  const [newEvents, setNewEvents] = useState([]);
  const [loading, setLoading] = useState('loading'); // 'loading' | 'refreshing' | 'idle'
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const prevIds = useRef(new Set());

  const fetchEvents = useCallback(async (isFirst = false) => {
    if (!isFirst) setLoading('refreshing');
    try {
      const data = await listEvents({ limit: 100 });
      const fetched = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];

      // Detect new events for live feed
      const incoming = fetched.filter(e => !prevIds.current.has(e.id));
      if (incoming.length > 0) {
        setNewEvents(prev => [...incoming, ...prev].slice(0, 50));
      }
      fetched.forEach(e => prevIds.current.add(e.id));

      setEvents(fetched);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading('idle');
    }
  }, []);

  useEffect(() => {
    setLoading('loading');
    fetchEvents(true);
    const id = setInterval(() => fetchEvents(false), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchEvents]);

  return { events, newEvents, loading, error, lastUpdated, refetch: fetchEvents };
}
