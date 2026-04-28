import { formatDistanceToNow } from 'date-fns';
import { useAuth } from '../../context/AuthContext';
import StatusDot from '../common/StatusDot';
import { APP_NAME } from '../../utils/constants';

export default function Header({ healthStatus, lastUpdated, isRefreshing }) {
  const { user, logout } = useAuth();

  return (
    <header className="bg-surface-card border-b border-surface-elevated px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-2xl">📡</span>
        <div>
          <h1 className="text-lg font-bold text-white leading-tight">{APP_NAME}</h1>
          {user && (
            <p className="text-xs text-gray-500">{user.email} · {user.role}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-4">
        {isRefreshing && (
          <svg className="animate-spin h-4 w-4 text-gray-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}

        {lastUpdated && (
          <span className="text-xs text-gray-500 hidden sm:block">
            Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
          </span>
        )}

        {healthStatus && <StatusDot status={healthStatus} />}

        <button
          onClick={logout}
          className="text-xs text-gray-400 hover:text-gray-200 transition-colors px-3 py-1.5 rounded-md hover:bg-surface-elevated"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
