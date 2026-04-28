import { useMemo } from 'react';
import FeedEventItem from './FeedEventItem';
import EmptyState from '../common/EmptyState';
import Skeleton from '../common/Skeleton';

export default function LiveEventFeed({ events, newEvents, loading }) {
  const newEventIds = useMemo(() => new Set(newEvents.map(e => e.id)), [newEvents]);

  // Merge: new events first, then remaining recent events, capped at 30
  const feedItems = useMemo(() => {
    const all = [...newEvents, ...events.filter(e => !newEventIds.has(e.id))];
    return all.slice(0, 30);
  }, [events, newEvents, newEventIds]);

  return (
    <div className="card p-0 overflow-hidden">
      <div className="px-6 py-4 border-b border-surface-elevated flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
          Live Event Feed
        </h3>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-dot" />
          <span className="text-xs text-gray-500">Auto-refreshing every 30s</span>
        </div>
      </div>

      <div className="overflow-y-auto max-h-96">
        {loading === 'loading' ? (
          <div className="space-y-px">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-surface-elevated">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-3 flex-1" />
              </div>
            ))}
          </div>
        ) : feedItems.length === 0 ? (
          <EmptyState message="No events yet" subtext="Events will appear here as they come in" />
        ) : (
          feedItems.map(event => (
            <FeedEventItem
              key={event.id}
              event={event}
              isNew={newEventIds.has(event.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
