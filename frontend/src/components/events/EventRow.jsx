import SeverityBadge from './SeverityBadge';
import EventExpandedPanel from './EventExpandedPanel';
import { formatTimestamp } from '../../utils/dateUtils';

export default function EventRow({ event, alerts, onAlertAction, isExpanded, onToggle }) {
  return (
    <>
      <tr
        className="border-b border-surface-elevated hover:bg-surface-elevated/50 cursor-pointer transition-colors"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
          {formatTimestamp(event.timestamp)}
        </td>
        <td className="px-4 py-3 text-xs text-gray-300 whitespace-nowrap">
          <span className="px-2 py-0.5 bg-surface-elevated rounded text-gray-300">{event.source || '—'}</span>
        </td>
        <td className="px-4 py-3 text-sm text-gray-200 max-w-xs truncate">
          {event.title || event.type || '—'}
        </td>
        <td className="px-4 py-3">
          <SeverityBadge severity={event.severity} />
        </td>
        <td className="px-4 py-3 text-xs text-gray-400 max-w-xs truncate hidden md:table-cell">
          {event.aiSummary || <span className="text-gray-600">—</span>}
        </td>
        <td className="px-4 py-3 text-xs text-gray-400 whitespace-nowrap">
          <span className={`capitalize ${event.status === 'alerted' ? 'text-green-400' : ''}`}>
            {event.status || '—'}
          </span>
        </td>
        <td className="px-4 py-3 text-gray-500 text-center">
          <span className={`transition-transform inline-block ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={7} className="p-0">
            <EventExpandedPanel
              eventId={event.id}
              eventTimestamp={event.timestamp}
              alerts={alerts}
              onAlertAction={onAlertAction}
            />
          </td>
        </tr>
      )}
    </>
  );
}
