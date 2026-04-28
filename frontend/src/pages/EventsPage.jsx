import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal, Trash2, ExternalLink, Bot, ChevronDown } from 'lucide-react';
import { listEvents, deleteEvent } from '../api/events';
import { useAuth } from '../context/AuthContext';
import SeverityBadge from '../components/events/SeverityBadge';
import EmptyState from '../components/common/EmptyState';
import { formatRelative, formatTimestamp } from '../utils/dateUtils';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SOURCES = ['api', 'webhook', 'manual'];
const TYPES = ['error', 'warning', 'info', 'critical'];

function FilterBar({ filters, onChange, count, loading }) {
  return (
    <div className="flex flex-wrap items-center gap-3 p-4 bg-surface-card border-b border-surface-elevated">
      <div className="flex items-center gap-2 text-gray-400">
        <SlidersHorizontal size={16} />
        <span className="text-xs font-medium uppercase tracking-wider">Filter</span>
      </div>

      <input
        type="text"
        placeholder="Search by title, source, type..."
        value={filters.search}
        onChange={e => onChange('search', e.target.value)}
        className="flex-1 min-w-[200px] bg-surface-elevated border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
      />

      <select
        value={filters.severity}
        onChange={e => onChange('severity', e.target.value)}
        className="bg-surface-elevated border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
      >
        <option value="">All Severities</option>
        {SEVERITIES.map(s => (
          <option key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</option>
        ))}
      </select>

      <select
        value={filters.source}
        onChange={e => onChange('source', e.target.value)}
        className="bg-surface-elevated border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
      >
        <option value="">All Sources</option>
        {SOURCES.map(s => (
          <option key={s} value={s} className="capitalize">{s.charAt(0).toUpperCase() + s.slice(1)}</option>
        ))}
      </select>

      <select
        value={filters.type}
        onChange={e => onChange('type', e.target.value)}
        className="bg-surface-elevated border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-indigo-500"
      >
        <option value="">All Types</option>
        {TYPES.map(t => (
          <option key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</option>
        ))}
      </select>

      {!loading && (
        <span className="text-xs text-gray-500 ml-auto">{count} event{count !== 1 ? 's' : ''}</span>
      )}
    </div>
  );
}

function EventTableRow({ event, isAdmin, onDelete, onView }) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this event? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await onDelete(event.id, event.timestamp);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <tr
      className="border-b border-surface-elevated hover:bg-surface-elevated/40 cursor-pointer transition-colors group"
      onClick={() => onView(event)}
    >
      <td className="px-4 py-3">
        <SeverityBadge severity={event.severity} />
      </td>
      <td className="px-4 py-3">
        <p className="text-sm text-gray-200 truncate max-w-xs" title={event.title || event.type}>
          {event.title || event.type || '—'}
        </p>
        {event.description && (
          <p className="text-xs text-gray-500 truncate max-w-xs mt-0.5">{event.description}</p>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="text-xs px-2 py-0.5 bg-surface-elevated rounded text-gray-300">
          {event.source || '—'}
        </span>
      </td>
      <td className="px-4 py-3">
        <span className="text-xs text-gray-400 capitalize">{event.type || '—'}</span>
      </td>
      <td className="px-4 py-3">
        <span
          className="text-xs text-gray-400"
          title={formatTimestamp(event.timestamp)}
        >
          {formatRelative(event.timestamp)}
        </span>
      </td>
      <td className="px-4 py-3 text-center">
        {(event.aiSummary || event.aiSeverity) && (
          <Bot size={14} className="text-indigo-400 mx-auto" title="AI analysis available" />
        )}
      </td>
      <td className="px-4 py-3">
        <span className={`text-xs capitalize ${
          event.status === 'alerted' ? 'text-green-400' :
          event.status === 'analyzed' ? 'text-blue-400' :
          event.status === 'processing' ? 'text-amber-400' :
          'text-gray-500'
        }`}>
          {event.status || '—'}
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2 justify-end opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); onView(event); }}
            className="p-1 text-gray-400 hover:text-indigo-400 transition-colors"
            title="View details"
          >
            <ExternalLink size={14} />
          </button>
          {isAdmin && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="p-1 text-gray-400 hover:text-red-400 transition-colors disabled:opacity-50"
              title="Delete event"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-0">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-surface-elevated animate-pulse">
          <div className="h-5 w-16 bg-surface-elevated rounded" />
          <div className="h-4 flex-1 bg-surface-elevated rounded" />
          <div className="h-4 w-16 bg-surface-elevated rounded" />
          <div className="h-4 w-14 bg-surface-elevated rounded" />
          <div className="h-4 w-20 bg-surface-elevated rounded" />
        </div>
      ))}
    </div>
  );
}

export default function EventsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastKey, setLastKey] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [filters, setFilters] = useState({
    search: '',
    severity: '',
    source: '',
    type: '',
  });

  const handleFilterChange = useCallback((key, value) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    // Reset pagination when filters change (server-side filters)
    if (key !== 'search') {
      setEvents([]);
      setLastKey(null);
    }
  }, []);

  const fetchEvents = useCallback(async (append = false) => {
    if (!append) setLoading(true);
    else setLoadingMore(true);
    try {
      const params = { limit: 50 };
      if (filters.severity) params.severity = filters.severity;
      if (filters.source) params.source = filters.source;
      if (filters.type) params.type = filters.type;
      if (append && lastKey) params.lastKey = lastKey;

      const data = await listEvents(params);
      const fetched = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];

      setEvents(prev => append ? [...prev, ...fetched] : fetched);
      setLastKey(data?.lastKey || null);
      setHasMore(!!data?.lastKey);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load events');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [filters.severity, filters.source, filters.type, lastKey]);

  // Refetch when server-side filters change
  useEffect(() => {
    setEvents([]);
    setLastKey(null);
    setHasMore(false);
    setLoading(true);
    listEvents({
      limit: 50,
      ...(filters.severity && { severity: filters.severity }),
      ...(filters.source && { source: filters.source }),
      ...(filters.type && { type: filters.type }),
    })
      .then(data => {
        const fetched = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
        setEvents(fetched);
        setLastKey(data?.lastKey || null);
        setHasMore(!!data?.lastKey);
        setError(null);
      })
      .catch(err => setError(err.message || 'Failed to load events'))
      .finally(() => setLoading(false));
  }, [filters.severity, filters.source, filters.type]);

  const handleLoadMore = useCallback(async () => {
    if (!lastKey || loadingMore) return;
    setLoadingMore(true);
    try {
      const params = { limit: 50, lastKey };
      if (filters.severity) params.severity = filters.severity;
      if (filters.source) params.source = filters.source;
      if (filters.type) params.type = filters.type;

      const data = await listEvents(params);
      const fetched = Array.isArray(data?.events) ? data.events : Array.isArray(data) ? data : [];
      setEvents(prev => [...prev, ...fetched]);
      setLastKey(data?.lastKey || null);
      setHasMore(!!data?.lastKey);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingMore(false);
    }
  }, [lastKey, loadingMore, filters]);

  const handleDelete = useCallback(async (id, timestamp) => {
    await deleteEvent(id, timestamp);
    setEvents(prev => prev.filter(e => e.id !== id));
  }, []);

  const handleView = useCallback((event) => {
    const ts = encodeURIComponent(event.timestamp || '');
    navigate(`/events/${event.id}${ts ? `?timestamp=${ts}` : ''}`);
  }, [navigate]);

  // Client-side search filter
  const displayedEvents = useMemo(() => {
    if (!filters.search.trim()) return events;
    const q = filters.search.toLowerCase();
    return events.filter(e =>
      (e.title || '').toLowerCase().includes(q) ||
      (e.type || '').toLowerCase().includes(q) ||
      (e.source || '').toLowerCase().includes(q) ||
      (e.description || '').toLowerCase().includes(q)
    );
  }, [events, filters.search]);

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-5 border-b border-surface-elevated bg-surface-card">
        <h1 className="text-lg font-semibold text-white">Events</h1>
        <p className="text-xs text-gray-500 mt-0.5">Browse and filter all ingested events</p>
      </div>

      {/* Filter bar */}
      <FilterBar
        filters={filters}
        onChange={handleFilterChange}
        count={displayedEvents.length}
        loading={loading}
      />

      {/* Error */}
      {error && (
        <div className="mx-4 mt-4 px-4 py-3 bg-red-900/30 border border-red-800 text-red-300 rounded-lg text-sm">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <TableSkeleton />
        ) : displayedEvents.length === 0 ? (
          <EmptyState
            icon="📭"
            message="No events found"
            subtext={filters.search || filters.severity || filters.source || filters.type
              ? 'Try adjusting your filters'
              : 'Events will appear here as they are ingested'
            }
          />
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-surface-card border-b border-surface-elevated z-10">
              <tr>
                {['Severity', 'Title', 'Source', 'Type', 'Time', 'AI', 'Status', ''].map(col => (
                  <th
                    key={col}
                    className={`px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap ${
                      col === 'AI' ? 'text-center' : ''
                    } ${col === '' ? 'w-16' : ''}`}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayedEvents.map(event => (
                <EventTableRow
                  key={event.id}
                  event={event}
                  isAdmin={isAdmin}
                  onDelete={handleDelete}
                  onView={handleView}
                />
              ))}
            </tbody>
          </table>
        )}

        {/* Load More */}
        {hasMore && !loading && (
          <div className="flex justify-center py-6">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="flex items-center gap-2 px-4 py-2 bg-surface-elevated hover:bg-gray-600 text-gray-300 text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {loadingMore ? (
                <>
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Loading...
                </>
              ) : (
                <>
                  <ChevronDown size={16} />
                  Load More
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
