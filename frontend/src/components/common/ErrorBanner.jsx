import { useState } from 'react';

export default function ErrorBanner({ message, onDismiss }) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-red-900/40 border border-red-700 text-red-300 rounded-lg text-sm">
      <span>⚠ {message}</span>
      <button
        onClick={handleDismiss}
        className="ml-4 text-red-400 hover:text-red-200 transition-colors text-lg leading-none"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
}
