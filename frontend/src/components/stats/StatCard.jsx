import StatCardSkeleton from './StatCardSkeleton';

const TREND_ICONS = {
  up: { icon: '↑', classes: 'text-red-400' },
  down: { icon: '↓', classes: 'text-green-400' },
  neutral: { icon: '→', classes: 'text-gray-400' },
};

export default function StatCard({ label, value, subtext, trend, colorClass, loading }) {
  if (loading) return <StatCardSkeleton />;

  const trendInfo = trend ? TREND_ICONS[trend] : null;

  return (
    <div className="card">
      <p className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">{label}</p>
      <div className="flex items-end gap-2">
        <p className={`text-3xl font-bold text-white ${colorClass || ''}`}>{value ?? '—'}</p>
        {trendInfo && (
          <span className={`text-lg font-semibold mb-0.5 ${trendInfo.classes}`}>
            {trendInfo.icon}
          </span>
        )}
      </div>
      {subtext && (
        <p className="text-xs text-gray-500 mt-1">{subtext}</p>
      )}
    </div>
  );
}
