export default function EmptyState({ icon = '📭', message = 'No data available', subtext }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-gray-500">
      <div className="text-4xl mb-3">{icon}</div>
      <p className="text-sm font-medium text-gray-400">{message}</p>
      {subtext && <p className="text-xs mt-1">{subtext}</p>}
    </div>
  );
}
