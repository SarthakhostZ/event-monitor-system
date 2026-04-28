import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatRelative } from '../../utils/dateUtils';
import SeverityBadge from '../events/SeverityBadge';

const BORDER_COLORS = {
  low: 'border-severity-low',
  medium: 'border-severity-medium',
  high: 'border-severity-high',
  critical: 'border-severity-critical',
};

export default function FeedEventItem({ event, isNew }) {
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isNew || !ref.current) return;
    ref.current.classList.add('animate-slide-in');
    const timer = setTimeout(() => {
      ref.current?.classList.remove('animate-slide-in');
    }, 300);
    return () => clearTimeout(timer);
  }, [isNew]);

  const borderClass = BORDER_COLORS[event.severity] || 'border-gray-600';

  const handleClick = () => {
    const ts = event.timestamp ? `?timestamp=${encodeURIComponent(event.timestamp)}` : '';
    navigate(`/events/${event.id}${ts}`);
  };

  return (
    <div
      ref={ref}
      onClick={handleClick}
      className={`flex items-start gap-3 px-4 py-3 border-b border-surface-elevated border-l-4 ${borderClass} hover:bg-surface-elevated/30 transition-colors cursor-pointer`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {formatRelative(event.timestamp)}
          </span>
          {event.source && (
            <span className="text-xs text-gray-500 px-1.5 py-0.5 bg-surface-elevated rounded">
              {event.source}
            </span>
          )}
          <SeverityBadge severity={event.severity} />
        </div>
        <p className="text-sm text-gray-200 mt-0.5 truncate">
          {event.title || event.type || 'Unknown event'}
        </p>
      </div>
    </div>
  );
}
