import Skeleton from '../common/Skeleton';

export default function ChartSkeleton({ height = 'h-48' }) {
  return (
    <div className="space-y-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className={`w-full ${height}`} />
    </div>
  );
}
