import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import ChartSkeleton from './ChartSkeleton';
import EmptyState from '../common/EmptyState';

export default function SeverityDonut({ data, loading }) {
  if (loading) {
    return (
      <div className="card">
        <ChartSkeleton height="h-56" />
      </div>
    );
  }

  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">
        Severity Distribution
      </h3>
      {total === 0 ? (
        <EmptyState message="No events yet" />
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={80}
              dataKey="value"
              paddingAngle={3}
            >
              {data.map(entry => (
                <Cell key={entry.name} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '8px' }}
              labelStyle={{ color: '#9ca3af' }}
              itemStyle={{ color: '#e5e7eb' }}
              formatter={(val, name) => [val, name]}
            />
            <Legend
              formatter={(value) => (
                <span style={{ color: '#9ca3af', fontSize: '12px' }}>{value}</span>
              )}
            />
            {/* Center label */}
            <text x="50%" y="46%" textAnchor="middle" dominantBaseline="middle" fill="#ffffff" fontSize="22" fontWeight="bold">
              {total}
            </text>
            <text x="50%" y="56%" textAnchor="middle" dominantBaseline="middle" fill="#6b7280" fontSize="11">
              total
            </text>
          </PieChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
