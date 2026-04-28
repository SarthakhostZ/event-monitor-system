import { SEVERITY_BADGE_CLASSES } from '../../utils/constants';

export default function SeverityBadge({ severity }) {
  const classes = SEVERITY_BADGE_CLASSES[severity] || 'bg-gray-800 text-gray-400';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold uppercase tracking-wide ${classes}`}>
      {severity}
    </span>
  );
}
