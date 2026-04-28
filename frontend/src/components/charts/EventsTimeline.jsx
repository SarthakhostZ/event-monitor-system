import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import ChartSkeleton from './ChartSkeleton';
import EmptyState from '../common/EmptyState';
import { SEVERITY_COLORS } from '../../utils/constants';

export default function EventsTimeline({ data, loading }) {
  if (loading) {
    return (
      <div className="card">
        <ChartSkeleton height="h-56" />
      </div>
    );
  }

  const hasData = data.some(d => d.low + d.medium + d.high + d.critical > 0);

  // Show every 4th hour label to avoid crowding
  const tickFormatter = (value, index) => index % 4 === 0 ? value : '';

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
        Events Timeline (24h)
      </h3>
      {!hasData ? (
        <EmptyState message="No events in the last 24 hours" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <defs>
              {['low', 'medium', 'high', 'critical'].map(sev => (
                <linearGradient key={sev} id={`grad-${sev}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SEVERITY_COLORS[sev]} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={SEVERITY_COLORS[sev]} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
            <XAxis dataKey="hour" tick={{ fill: '#6b7280', fontSize: 11 }} tickFormatter={tickFormatter} />
            <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} allowDecimals={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              labelStyle={{ color: '#9ca3af' }}
              itemStyle={{ color: '#e5e7eb' }}
            />
            <Legend formatter={val => <span style={{ color: '#9ca3af', fontSize: '12px' }}>{val}</span>} />
            {['low', 'medium', 'high', 'critical'].map(sev => (
              <Area
                key={sev}
                type="monotone"
                dataKey={sev}
                stackId="1"
                stroke={SEVERITY_COLORS[sev]}
                fill={`url(#grad-${sev})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
