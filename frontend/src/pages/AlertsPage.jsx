import { useState, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck, XCircle, Inbox, ExternalLink } from 'lucide-react';
import useAlerts from '../hooks/useAlerts';
import { useAuth } from '../context/AuthContext';
import { acknowledgeAlert, resolveAlert } from '../api/alerts';
import SeverityBadge from '../components/events/SeverityBadge';
import EmptyState from '../components/common/EmptyState';
import { formatRelative, formatTimestamp } from '../utils/dateUtils';

const STATUS_TABS = [
  { key: 'open', label: 'Open', icon: Bell },
  { key: 'acknowledged', label: 'Acknowledged', icon: Inbox },
  { key: 'resolved', label: 'Resolved', icon: CheckCheck },
  { key: 'all', label: 'All', icon: null },
];

const STATUS_BADGE = {
  open: { cls: 'bg-red-900/50 text-red-300 border border-red-800', label: 'Open' },
  acknowledged: { cls: 'bg-amber-900/50 text-amber-300 border border-amber-800', label: 'Acknowledged' },
  resolved: { cls: 'bg-green-900/50 text-green-300 border border-green-800', label: 'Resolved' },
};

function AlertStatusBadge({ status }) {
  const config = STATUS_BADGE[status] || { cls: 'bg-gray-800 text-gray-400', label: status };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${config.cls}`}>
      {config.label}
    </span>
  );
}

function ActionButtons({ alert, canAct, onActionComplete }) {
  const [loading, setLoading] = useState(null);

  if (!canAct || alert.status === 'resolved') {
    return alert.status === 'resolved' ? (
      <span className="text-xs text-green-400 flex items-center gap-1">
        <CheckCheck size={12} /> Resolved
      </span>
    ) : null;
  }

  const handle = async (action) => {
    setLoading(action);
    try {
      if (action === 'acknowledge') await acknowledgeAlert(alert.id || alert.alertId);
      else await resolveAlert(alert.id || alert.alertId);
      onActionComplete?.();
    } catch {
      // next poll will reflect reality
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {alert.status === 'open' && (
        <button
          onClick={() => handle('acknowledge')}
          disabled={loading !== null}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-amber-900/40 text-amber-300 hover:bg-amber-900/70 border border-amber-800/50 transition-colors disabled:opacity-50"
        >
          <Inbox size={11} />
          {loading === 'acknowledge' ? '...' : 'Acknowledge'}
        </button>
      )}
      {(alert.status === 'open' || alert.status === 'acknowledged') && (
        <button
          onClick={() => handle('resolve')}
          disabled={loading !== null}
          className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-green-900/40 text-green-300 hover:bg-green-900/70 border border-green-800/50 transition-colors disabled:opacity-50"
        >
          <CheckCheck size={11} />
          {loading === 'resolve' ? '...' : 'Resolve'}
        </button>
      )}
    </div>
  );
}

function AlertCard({ alert, canAct, onActionComplete }) {
  const isResolved = alert.status === 'resolved';

  return (
    <div className={`card transition-all ${isResolved ? 'opacity-60' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        {/* Left: severity + info */}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {alert.severity && <SeverityBadge severity={alert.severity} />}
            <AlertStatusBadge status={alert.status} />
            <span className="text-xs text-gray-500" title={formatTimestamp(alert.timestamp)}>
              {formatRelative(alert.timestamp)}
            </span>
          </div>

          <p className="text-sm font-medium text-gray-200 mb-1">
            {alert.message || alert.title || `Alert for event ${alert.eventId || '—'}`}
          </p>

          {alert.channels && alert.channels.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {alert.channels.map(ch => (
                <span key={ch} className="text-xs px-1.5 py-0.5 bg-surface-elevated rounded text-gray-400">
                  {ch}
                </span>
              ))}
            </div>
          )}

          {alert.eventId && (
            <div className="flex items-center gap-1.5 mt-2">
              <span className="text-xs text-gray-500">Event:</span>
              <Link
                to={`/events/${alert.eventId}`}
                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 font-mono"
              >
                {alert.eventId.slice(0, 8)}…
                <ExternalLink size={10} />
              </Link>
            </div>
          )}

          {alert.retryCount > 0 && (
            <p className="text-xs text-gray-500 mt-1">Retry count: {alert.retryCount}</p>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex-shrink-0">
          <ActionButtons alert={alert} canAct={canAct} onActionComplete={onActionComplete} />
        </div>
      </div>
    </div>
  );
}

function AlertCardSkeleton() {
  return (
    <div className="card animate-pulse space-y-3">
      <div className="flex gap-2">
        <div className="h-5 w-16 bg-surface-elevated rounded" />
        <div className="h-5 w-20 bg-surface-elevated rounded" />
        <div className="h-5 w-24 bg-surface-elevated rounded ml-auto" />
      </div>
      <div className="h-4 w-3/4 bg-surface-elevated rounded" />
      <div className="h-4 w-1/2 bg-surface-elevated rounded" />
    </div>
  );
}

export default function AlertsPage() {
  const { alerts, loading, error, refetch } = useAlerts();
  const { user } = useAuth();
  const canAct = user?.role === 'operator' || user?.role === 'admin';

  const [activeTab, setActiveTab] = useState('open');

  const counts = useMemo(() => ({
    open: alerts.filter(a => a.status === 'open').length,
    acknowledged: alerts.filter(a => a.status === 'acknowledged').length,
    resolved: alerts.filter(a => a.status === 'resolved').length,
    all: alerts.length,
  }), [alerts]);

  const displayed = useMemo(() => {
    if (activeTab === 'all') return [...alerts].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return alerts
      .filter(a => a.status === activeTab)
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  }, [alerts, activeTab]);

  const isLoading = loading === 'loading';

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="px-6 py-5 border-b border-surface-elevated bg-surface-card">
        <h1 className="text-lg font-semibold text-white">Alert Inbox</h1>
        <p className="text-xs text-gray-500 mt-0.5">Monitor and action alerts generated by the system</p>
      </div>

      {/* Status tabs */}
      <div className="px-6 border-b border-surface-elevated bg-surface-card">
        <div className="flex gap-1 -mb-px overflow-x-auto">
          {STATUS_TABS.map(tab => {
            const count = counts[tab.key];
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  isActive
                    ? 'border-indigo-500 text-indigo-400'
                    : 'border-transparent text-gray-400 hover:text-gray-200'
                }`}
              >
                {tab.label}
                {!isLoading && count > 0 && (
                  <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${
                    tab.key === 'open' ? 'bg-red-500 text-white' :
                    tab.key === 'acknowledged' ? 'bg-amber-500 text-white' :
                    tab.key === 'resolved' ? 'bg-green-600 text-white' :
                    'bg-gray-600 text-gray-200'
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        {error && (
          <div className="mb-4 px-4 py-3 bg-red-900/30 border border-red-800 text-red-300 rounded-lg text-sm">
            {error}
          </div>
        )}

        {!canAct && !isLoading && (
          <div className="mb-4 px-4 py-3 bg-surface-elevated border border-gray-600 text-gray-400 rounded-lg text-sm flex items-center gap-2">
            <XCircle size={14} />
            <span>You have read-only access. Contact an operator or admin to action alerts.</span>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {Array.from({ length: 4 }).map((_, i) => <AlertCardSkeleton key={i} />)}
          </div>
        ) : displayed.length === 0 ? (
          <EmptyState
            icon={activeTab === 'open' ? '✅' : '📭'}
            message={activeTab === 'open' ? 'No open alerts' : `No ${activeTab} alerts`}
            subtext={activeTab === 'open' ? 'All clear — no alerts require attention' : `No alerts with status "${activeTab}"`}
          />
        ) : (
          <div className="space-y-4">
            {displayed.map(alert => (
              <AlertCard
                key={alert.id || alert.alertId}
                alert={alert}
                canAct={canAct}
                onActionComplete={refetch}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
