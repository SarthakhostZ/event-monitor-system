import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import useEvents from '../hooks/useEvents';
import useAlerts from '../hooks/useAlerts';
import { deriveStats, buildTimelineBuckets, groupBySource, groupBySeverity } from '../utils/statsUtils';
import StatsRow from '../components/stats/StatsRow';
import SeverityDonut from '../components/charts/SeverityDonut';
import EventsTimeline from '../components/charts/EventsTimeline';
import EventsBySource from '../components/charts/EventsBySource';
import LiveEventFeed from '../components/feed/LiveEventFeed';
import ErrorBanner from '../components/common/ErrorBanner';
import SeverityBadge from '../components/events/SeverityBadge';
import { formatRelative } from '../utils/dateUtils';

function RecentEventsPreview({ events, loading }) {
  const navigate = useNavigate();
  const recent = events.slice(0, 5);

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-surface-elevated flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">Recent Events</h3>
        <Link to="/events" className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          View all <ArrowRight size={12} />
        </Link>
      </div>
      {loading ? (
        <div className="space-y-px">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-surface-elevated animate-pulse">
              <div className="h-4 w-14 bg-surface-elevated rounded" />
              <div className="h-4 flex-1 bg-surface-elevated rounded" />
              <div className="h-4 w-16 bg-surface-elevated rounded" />
            </div>
          ))}
        </div>
      ) : recent.length === 0 ? (
        <div className="px-6 py-8 text-center text-gray-500 text-sm">No events yet</div>
      ) : (
        <div>
          {recent.map(event => (
            <div
              key={event.id}
              onClick={() => navigate(`/events/${event.id}${event.timestamp ? `?timestamp=${encodeURIComponent(event.timestamp)}` : ''}`)}
              className="flex items-center gap-3 px-4 py-3 border-b border-surface-elevated hover:bg-surface-elevated/40 cursor-pointer transition-colors"
            >
              <SeverityBadge severity={event.severity} />
              <span className="text-sm text-gray-200 flex-1 truncate">{event.title || event.type || 'Unknown'}</span>
              <span className="text-xs text-gray-500 whitespace-nowrap">{formatRelative(event.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenAlertsPreview({ alerts, loading, onAction }) {
  const openAlerts = alerts.filter(a => a.status === 'open').slice(0, 5);

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-surface-elevated flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Open Alerts
          {!loading && openAlerts.length > 0 && (
            <span className="ml-2 px-1.5 py-0.5 rounded-full text-xs bg-red-500 text-white">{openAlerts.length}</span>
          )}
        </h3>
        <Link to="/alerts" className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
          View all <ArrowRight size={12} />
        </Link>
      </div>
      {loading ? (
        <div className="space-y-px">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-surface-elevated animate-pulse">
              <div className="h-4 flex-1 bg-surface-elevated rounded" />
              <div className="h-4 w-20 bg-surface-elevated rounded" />
            </div>
          ))}
        </div>
      ) : openAlerts.length === 0 ? (
        <div className="px-6 py-8 text-center text-gray-500 text-sm">
          <span className="text-2xl block mb-2">✅</span>
          No open alerts
        </div>
      ) : (
        <div>
          {openAlerts.map(alert => (
            <Link
              key={alert.id || alert.alertId}
              to="/alerts"
              className="flex items-center gap-3 px-4 py-3 border-b border-surface-elevated hover:bg-surface-elevated/40 transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse-dot flex-shrink-0" />
              <span className="text-sm text-gray-200 flex-1 truncate">
                {alert.message || alert.title || `Alert ${(alert.id || alert.alertId || '').slice(0, 8)}`}
              </span>
              <span className="text-xs text-gray-500 whitespace-nowrap">{formatRelative(alert.timestamp)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const {
    events,
    newEvents,
    loading: eventsLoading,
    error: eventsError,
  } = useEvents();

  const {
    alerts,
    loading: alertsLoading,
    error: alertsError,
    refetch: refetchAlerts,
  } = useAlerts();

  const isFirstLoad = eventsLoading === 'loading';

  const stats = useMemo(() => deriveStats(events, alerts), [events, alerts]);
  const timelineBuckets = useMemo(() => buildTimelineBuckets(events), [events]);
  const sourceCounts = useMemo(() => groupBySource(events), [events]);
  const severityCounts = useMemo(() => groupBySeverity(events), [events]);

  return (
    <div className="p-4 md:p-6 space-y-6">
      {(eventsError || alertsError) && (
        <div className="space-y-2">
          {eventsError && <ErrorBanner message={`Events: ${eventsError}`} />}
          {alertsError && <ErrorBanner message={`Alerts: ${alertsError}`} />}
        </div>
      )}

      {/* KPI stats row */}
      <StatsRow stats={stats} loading={isFirstLoad} />

      {/* Charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <SeverityDonut data={severityCounts} loading={isFirstLoad} />
        <div className="lg:col-span-2">
          <EventsTimeline data={timelineBuckets} loading={isFirstLoad} />
        </div>
      </div>

      {/* Source breakdown */}
      <EventsBySource data={sourceCounts} loading={isFirstLoad} />

      {/* Recent activity row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecentEventsPreview events={events} loading={isFirstLoad} />
        <OpenAlertsPreview alerts={alerts} loading={alertsLoading === 'loading'} onAction={refetchAlerts} />
      </div>

      {/* Live feed */}
      <LiveEventFeed
        events={events}
        newEvents={newEvents}
        loading={eventsLoading}
      />
    </div>
  );
}
