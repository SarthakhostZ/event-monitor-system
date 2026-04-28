import Skeleton from '../common/Skeleton';

export default function TableSkeleton({ rows = 5 }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex gap-4 px-4 py-3 border-b border-surface-elevated">
          <Skeleton className="h-4 w-24 flex-shrink-0" />
          <Skeleton className="h-4 w-16 flex-shrink-0" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16 flex-shrink-0" />
          <Skeleton className="h-4 w-40 hidden md:block flex-shrink-0" />
          <Skeleton className="h-4 w-20 flex-shrink-0" />
        </div>
      ))}
    </div>
  );
}
