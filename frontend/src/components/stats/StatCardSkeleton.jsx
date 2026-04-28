import Skeleton from '../common/Skeleton';

export default function StatCardSkeleton() {
  return (
    <div className="card space-y-3">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-20" />
      <Skeleton className="h-3 w-36" />
    </div>
  );
}
