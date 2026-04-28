export default function StatusDot({ status }) {
  const isHealthy = status === 'ok';
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={`inline-block w-2 h-2 rounded-full animate-pulse-dot ${
          isHealthy ? 'bg-green-400' : 'bg-red-400'
        }`}
      />
      <span className={`text-sm font-medium ${isHealthy ? 'text-green-400' : 'text-red-400'}`}>
        {isHealthy ? 'Healthy' : 'Degraded'}
      </span>
    </span>
  );
}
