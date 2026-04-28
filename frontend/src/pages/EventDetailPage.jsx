import { useState, useEffect } from 'react';
import { useParams, useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft,
  Copy,
  Check,
  Trash2,
  Bot,
  AlertTriangle,
  Info,
  Zap,
  Target,
} from 'lucide-react';
import { getEvent, deleteEvent } from '../api/events';
import { useAuth } from '../context/AuthContext';
import SeverityBadge from '../components/events/SeverityBadge';
import { formatTimestamp, formatRelative } from '../utils/dateUtils';
import Skeleton from '../components/common/Skeleton';

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for unsupported environments
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 text-gray-500 hover:text-gray-300 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
    </button>
  );
}

function StatusBadge({ status }) {
  const MAP = {
    new: 'bg-gray-800 text-gray-300',
    processing: 'bg-amber-900/50 text-amber-300',
    analyzed: 'bg-blue-900/50 text-blue-300',
    alerted: 'bg-green-900/50 text-green-300',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${MAP[status] || 'bg-gray-800 text-gray-400'}`}>
      {status || 'unknown'}
    </span>
  );
}

function AIAnalysisPanel({ event }) {
  const hasAI = event.aiSummary || event.aiSeverity || event.aiRecommendation || event.aiRootCause;

  if (!hasAI) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Bot size={16} className="text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-400">AI Analysis</h3>
        </div>
        <div className="flex items-center gap-2 text-gray-500 text-sm">
          <Info size={14} />
          <span>AI analysis not available for this event.</span>
        </div>
      </div>
    );
  }

  const confidence = event.aiConfidence != null ? event.aiConfidence : null;

  return (
    <div className="card border-indigo-900/50">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-indigo-400" />
          <h3 className="text-sm font-semibold text-indigo-300">AI Analysis</h3>
        </div>
        {confidence != null && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Confidence</span>
            <div className="w-24 bg-surface-elevated rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full ${
                  confidence >= 75 ? 'bg-green-400' : confidence >= 50 ? 'bg-amber-400' : 'bg-red-400'
                }`}
                style={{ width: `${confidence}%` }}
              />
            </div>
            <span className="text-xs text-gray-400 font-mono">{confidence}%</span>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {event.aiSummary && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Info size={12} className="text-indigo-400" />
              <p className="text-xs font-semibold text-indigo-400 uppercase tracking-wide">Summary</p>
            </div>
            <p className="text-sm text-gray-200 leading-relaxed">{event.aiSummary}</p>
          </div>
        )}

        {event.aiRootCause && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Target size={12} className="text-amber-400" />
              <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Root Cause</p>
            </div>
            <p className="text-sm text-gray-200 leading-relaxed">{event.aiRootCause}</p>
          </div>
        )}

        {event.aiRecommendation && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <Zap size={12} className="text-green-400" />
              <p className="text-xs font-semibold text-green-400 uppercase tracking-wide">Recommendation</p>
            </div>
            <p className="text-sm text-gray-200 leading-relaxed">{event.aiRecommendation}</p>
          </div>
        )}

        {event.aiSeverity && event.aiSeverity !== event.severity && (
          <div className="pt-3 border-t border-surface-elevated">
            <div className="flex items-center gap-2">
              <AlertTriangle size={12} className="text-amber-400" />
              <p className="text-xs text-gray-400">
                AI suggested severity:{' '}
                <span className="font-semibold text-amber-300 capitalize">{event.aiSeverity}</span>
                {' '}vs rule engine:{' '}
                <span className="font-semibold text-gray-300 capitalize">{event.severity}</span>
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetadataPanel({ metadata }) {
  if (!metadata || Object.keys(metadata).length === 0) return null;

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">Metadata</h3>
      <div className="space-y-2">
        {Object.entries(metadata).map(([key, val]) => (
          <div key={key} className="flex gap-3 text-sm">
            <span className="text-gray-500 font-mono text-xs w-36 flex-shrink-0 pt-0.5">{key}</span>
            <span className="text-gray-200 font-mono text-xs break-all">{String(val)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EventDetailSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <Skeleton className="h-8 w-64" />
      <div className="flex gap-3">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-24" />
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function EventDetailPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const timestamp = searchParams.get('timestamp');

  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getEvent(id, timestamp)
      .then(data => setEvent(data))
      .catch(err => setError(err.message || 'Event not found'))
      .finally(() => setLoading(false));
  }, [id, timestamp]);

  const handleDelete = async () => {
    if (!confirm('Permanently delete this event? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await deleteEvent(id, timestamp);
      navigate('/events');
    } catch (err) {
      alert(err.message || 'Failed to delete event');
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div>
        <div className="px-6 py-4 border-b border-surface-elevated bg-surface-card">
          <button className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-sm">
            <ArrowLeft size={16} /> Back to Events
          </button>
        </div>
        <EventDetailSkeleton />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Link to="/events" className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-sm mb-6">
          <ArrowLeft size={16} /> Back to Events
        </Link>
        <div className="card text-center py-12">
          <p className="text-4xl mb-3">🔍</p>
          <p className="text-gray-300 font-medium">Event not found</p>
          <p className="text-gray-500 text-sm mt-1">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Back navigation */}
      <div className="px-6 py-4 border-b border-surface-elevated bg-surface-card flex items-center justify-between">
        <Link to="/events" className="flex items-center gap-2 text-gray-400 hover:text-gray-200 text-sm transition-colors">
          <ArrowLeft size={16} />
          Back to Events
        </Link>

        {isAdmin && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="flex items-center gap-2 px-3 py-1.5 bg-red-900/30 hover:bg-red-900/50 border border-red-800 text-red-300 text-sm rounded-lg transition-colors disabled:opacity-50"
          >
            <Trash2 size={14} />
            {deleting ? 'Deleting...' : 'Delete Event'}
          </button>
        )}
      </div>

      <div className="p-6 space-y-6 max-w-5xl">
        {/* Header */}
        <div>
          <h1 className="text-xl font-bold text-white mb-3">
            {event.title || event.type || 'Event Detail'}
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <SeverityBadge severity={event.severity} />
            <StatusBadge status={event.status} />
            {event.source && (
              <span className="text-xs px-2 py-0.5 bg-surface-elevated rounded text-gray-300">
                {event.source}
              </span>
            )}
            {event.type && (
              <span className="text-xs text-gray-500 capitalize">{event.type}</span>
            )}
          </div>
        </div>

        {/* Meta info row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="card">
            <dl className="space-y-2">
              <div className="flex items-start gap-3">
                <dt className="text-xs text-gray-500 w-24 flex-shrink-0 pt-0.5">Event ID</dt>
                <dd className="flex items-center gap-1.5">
                  <span className="text-xs text-gray-200 font-mono break-all">{event.id || event.eventId}</span>
                  <CopyButton text={event.id || event.eventId} />
                </dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="text-xs text-gray-500 w-24 flex-shrink-0">Timestamp</dt>
                <dd className="text-xs text-gray-200 font-mono">{formatTimestamp(event.timestamp)}</dd>
              </div>
              <div className="flex items-center gap-3">
                <dt className="text-xs text-gray-500 w-24 flex-shrink-0">Relative</dt>
                <dd className="text-xs text-gray-400">{formatRelative(event.timestamp)}</dd>
              </div>
            </dl>
          </div>

          {event.description && (
            <div className="card">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Description</h3>
              <p className="text-sm text-gray-200 leading-relaxed">{event.description}</p>
            </div>
          )}
        </div>

        {/* AI Analysis */}
        <AIAnalysisPanel event={event} />

        {/* Metadata */}
        <MetadataPanel metadata={event.metadata} />

        {/* Raw payload */}
        {(event.payload || event.metadata) && (
          <div className="card">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Raw Payload</h3>
            <pre className="text-xs bg-surface text-gray-300 font-mono p-4 rounded-lg overflow-auto max-h-64 leading-relaxed">
              {JSON.stringify(event.payload ?? event.metadata ?? {}, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
