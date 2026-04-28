import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { getEvent } from '../../api/events';
import AlertActionButtons from '../alerts/AlertActionButtons';
import Skeleton from '../common/Skeleton';

export default function EventExpandedPanel({ eventId, eventTimestamp, alerts, onAlertAction }) {
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    getEvent(eventId, eventTimestamp)
      .then(data => setEvent(data))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [eventId, eventTimestamp]);

  const relatedAlert = alerts?.find(a => a.eventId === eventId);

  const handleViewDetail = () => {
    const ts = eventTimestamp ? `?timestamp=${encodeURIComponent(eventTimestamp)}` : '';
    navigate(`/events/${eventId}${ts}`);
  };

  if (loading) {
    return (
      <div className="p-4 space-y-3 bg-surface border-t border-surface-elevated">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400 bg-surface border-t border-surface-elevated">
        Failed to load event details: {error}
      </div>
    );
  }

  return (
    <div className="p-4 bg-surface border-t border-surface-elevated animate-fade-in">
      <div className="flex justify-end mb-3">
        <button
          onClick={handleViewDetail}
          className="flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          <ExternalLink size={12} />
          Full detail
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* AI Analysis */}
        {(event.aiSummary || event.aiRecommendation) && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-indigo-400 uppercase tracking-wide">AI Analysis</h4>
            {event.aiSummary && (
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Summary</p>
                <p className="text-sm text-gray-200">{event.aiSummary}</p>
              </div>
            )}
            {event.aiRecommendation && (
              <div>
                <p className="text-xs text-gray-500 mb-0.5">Recommendation</p>
                <p className="text-sm text-gray-200">{event.aiRecommendation}</p>
              </div>
            )}
            {event.aiSeverity && (
              <div>
                <p className="text-xs text-gray-500 mb-0.5">AI Severity</p>
                <p className="text-sm text-gray-200 capitalize">{event.aiSeverity}</p>
              </div>
            )}
          </div>
        )}

        {/* Payload */}
        <div>
          <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Payload</h4>
          <pre className="text-xs bg-surface-elevated p-3 rounded-lg overflow-auto max-h-40 text-gray-300 font-mono leading-relaxed">
            {JSON.stringify(event.payload || event.metadata || {}, null, 2)}
          </pre>
        </div>

        {/* Metadata */}
        {event.metadata && Object.keys(event.metadata).length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Metadata</h4>
            <div className="space-y-1">
              {Object.entries(event.metadata).map(([key, val]) => (
                <div key={key} className="flex gap-2 text-xs">
                  <span className="text-gray-500 font-medium w-28 flex-shrink-0">{key}</span>
                  <span className="text-gray-300 truncate">{String(val)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Alert actions */}
        {relatedAlert && (
          <div>
            <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Alert</h4>
            <p className="text-xs text-gray-400 mb-2">{relatedAlert.message}</p>
            <AlertActionButtons alert={relatedAlert} onActionComplete={onAlertAction} />
          </div>
        )}
      </div>
    </div>
  );
}
