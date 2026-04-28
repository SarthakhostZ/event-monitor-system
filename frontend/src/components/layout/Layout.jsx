import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  List,
  Bell,
  LogOut,
  Menu,
  X,
  Radio,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import useHealthCheck from '../../hooks/useHealthCheck';
import { APP_NAME } from '../../utils/constants';

const NAV_ITEMS = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/events', icon: List, label: 'Events' },
  { to: '/alerts', icon: Bell, label: 'Alerts' },
];

function NavItem({ to, icon: Icon, label, onClick }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
            : 'text-gray-400 hover:text-gray-200 hover:bg-surface-elevated'
        }`
      }
    >
      <Icon size={18} strokeWidth={1.8} />
      <span>{label}</span>
    </NavLink>
  );
}

function Sidebar({ onClose }) {
  const { user, logout } = useAuth();
  const { status: healthStatus } = useHealthCheck();

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center justify-between px-4 py-5 border-b border-surface-elevated">
        <div className="flex items-center gap-2.5">
          <Radio size={22} className="text-indigo-400" />
          <span className="text-white font-bold text-base leading-tight">{APP_NAME}</span>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 lg:hidden">
            <X size={20} />
          </button>
        )}
      </div>

      {/* Health indicator */}
      <div className="px-4 py-3 border-b border-surface-elevated">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full animate-pulse-dot ${
              healthStatus === 'ok' ? 'bg-green-400' : healthStatus === 'error' ? 'bg-red-400' : 'bg-gray-600'
            }`}
          />
          <span className={`text-xs font-medium ${
            healthStatus === 'ok' ? 'text-green-400' : healthStatus === 'error' ? 'text-red-400' : 'text-gray-500'
          }`}>
            {healthStatus === 'ok' ? 'System Healthy' : healthStatus === 'error' ? 'System Degraded' : 'Checking...'}
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map(item => (
          <NavItem key={item.to} {...item} onClick={onClose} />
        ))}
      </nav>

      {/* User info + logout */}
      <div className="px-3 py-4 border-t border-surface-elevated">
        {user && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-surface-elevated">
            <p className="text-xs font-medium text-gray-200 truncate">{user.email}</p>
            <p className="text-xs text-gray-500 capitalize mt-0.5">{user.role}</p>
          </div>
        )}
        <button
          onClick={logout}
          className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-surface-elevated transition-colors"
        >
          <LogOut size={16} strokeWidth={1.8} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-surface flex">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col w-56 bg-surface-card border-r border-surface-elevated flex-shrink-0">
        <Sidebar />
      </aside>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setSidebarOpen(false)}
          />
          <aside className="relative z-50 flex flex-col w-56 h-full bg-surface-card border-r border-surface-elevated">
            <Sidebar onClose={() => setSidebarOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile topbar */}
        <header className="lg:hidden flex items-center gap-3 px-4 py-3 bg-surface-card border-b border-surface-elevated">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-gray-200"
          >
            <Menu size={22} />
          </button>
          <div className="flex items-center gap-2">
            <Radio size={18} className="text-indigo-400" />
            <span className="text-white font-semibold text-sm">{APP_NAME}</span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
