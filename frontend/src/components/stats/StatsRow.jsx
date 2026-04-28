import StatCard from './StatCard';

export default function StatsRow({ stats, loading }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <StatCard
        label="Total Events (24h)"
        value={loading ? null : stats.totalEvents24h}
        subtext="last 24 hours"
        trend={stats?.trend}
        loading={loading}
      />
      <StatCard
        label="Critical Events"
        value={loading ? null : stats.criticalCount}
        subtext="require attention"
        colorClass={stats?.criticalCount > 0 ? 'text-severity-critical' : undefined}
        loading={loading}
      />
      <StatCard
        label="Alerts Sent"
        value={loading ? null : stats.totalAlerts}
        subtext={loading ? null : `${stats.successRate}% resolved`}
        loading={loading}
      />
      <StatCard
        label="Avg Response Time"
        value={loading ? null : stats.avgResponseTime != null ? `${stats.avgResponseTime}m` : 'N/A'}
        subtext="time to resolve"
        loading={loading}
      />
    </div>
  );
}
