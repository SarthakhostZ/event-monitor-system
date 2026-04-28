import { useState } from 'react';
import { acknowledgeAlert, resolveAlert } from '../../api/alerts';

export default function AlertActionButtons({ alert, onActionComplete }) {
  const [loading, setLoading] = useState(null); // 'acknowledge' | 'resolve' | null

  if (!alert || alert.status === 'resolved') {
    return <span className="text-xs text-green-400 font-medium">✓ Resolved</span>;
  }

  const handle = async (action) => {
    setLoading(action);
    try {
      if (action === 'acknowledge') {
        await acknowledgeAlert(alert.id);
      } else {
        await resolveAlert(alert.id);
      }
      onActionComplete?.();
    } catch {
      // silently fail — next poll will reflect real state
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex gap-2">
      {alert.status === 'open' && (
        <button
          onClick={() => handle('acknowledge')}
          disabled={loading !== null}
          className="text-xs px-2 py-1 rounded bg-amber-900/50 text-amber-300 hover:bg-amber-900 transition-colors disabled:opacity-50"
        >
          {loading === 'acknowledge' ? '...' : 'Ack'}
        </button>
      )}
      <button
        onClick={() => handle('resolve')}
        disabled={loading !== null}
        className="text-xs px-2 py-1 rounded bg-green-900/50 text-green-300 hover:bg-green-900 transition-colors disabled:opacity-50"
      >
        {loading === 'resolve' ? '...' : 'Resolve'}
      </button>
    </div>
  );
}
