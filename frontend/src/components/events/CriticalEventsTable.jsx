import { useState, useMemo } from 'react';
import EventRow from './EventRow';
import TableSkeleton from './TableSkeleton';
import EmptyState from '../common/EmptyState';

const SORT_FIELDS = {
  timestamp: (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
  source: (a, b) => (a.source || '').localeCompare(b.source || ''),
  type: (a, b) => (a.type || '').localeCompare(b.type || ''),
  severity: (a, b) => {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return (order[a.severity] ?? 4) - (order[b.severity] ?? 4);
  },
  status: (a, b) => (a.status || '').localeCompare(b.status || ''),
};

const COLUMNS = [
  { key: 'timestamp', label: 'Time' },
  { key: 'source', label: 'Source' },
  { key: 'type', label: 'Type / Title' },
  { key: 'severity', label: 'Severity' },
  { key: null, label: 'AI Summary' },
  { key: 'status', label: 'Status' },
  { key: null, label: '' },
];

export default function CriticalEventsTable({ events, alerts, loading, onAlertAction }) {
  const [sortField, setSortField] = useState('timestamp');
  const [sortDir, setSortDir] = useState('desc');
  const [filterText, setFilterText] = useState('');
  const [expandedRowId, setExpandedRowId] = useState(null);

  const handleSort = (field) => {
    if (!field) return;
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const filtered = useMemo(() => {
    if (!filterText.trim()) return events;
    const q = filterText.toLowerCase();
    return events.filter(e =>
      (e.source || '').toLowerCase().includes(q) ||
      (e.type || '').toLowerCase().includes(q) ||
      (e.status || '').toLowerCase().includes(q) ||
      (e.aiSummary || '').toLowerCase().includes(q)
    );
  }, [events, filterText]);

  const sorted = useMemo(() => {
    const fn = SORT_FIELDS[sortField];
    if (!fn) return filtered;
    return [...filtered].sort((a, b) => sortDir === 'asc' ? fn(a, b) : -fn(a, b));
  }, [filtered, sortField, sortDir]);

  const toggleRow = (id) => setExpandedRowId(prev => prev === id ? null : id);

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-surface-elevated">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Critical Events
          {!loading && <span className="ml-2 text-xs font-normal text-gray-500">({events.length})</span>}
        </h3>
        <input
          type="text"
          placeholder="Filter by source, type, status..."
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          className="w-full sm:w-64 bg-surface-elevated border border-gray-600 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
        />
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <TableSkeleton />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon="✅"
            message="No critical events"
            subtext={filterText ? 'Try clearing the filter' : 'System is running smoothly'}
          />
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-surface-elevated">
                {COLUMNS.map(col => (
                  <th
                    key={col.label}
                    onClick={() => handleSort(col.key)}
                    className={`px-4 py-3 text-xs font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap ${
                      col.key ? 'cursor-pointer hover:text-gray-200 select-none' : ''
                    } ${col.label === 'AI Summary' ? 'hidden md:table-cell' : ''}`}
                  >
                    {col.label}
                    {col.key === sortField && (
                      <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(event => (
                <EventRow
                  key={event.id}
                  event={event}
                  alerts={alerts}
                  onAlertAction={onAlertAction}
                  isExpanded={expandedRowId === event.id}
                  onToggle={() => toggleRow(event.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
