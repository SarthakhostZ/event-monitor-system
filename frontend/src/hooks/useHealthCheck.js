import { useState, useEffect } from 'react';
import axios from 'axios';
import { HEALTH_POLL_INTERVAL_MS, API_BASE_URL } from '../utils/constants';

export default function useHealthCheck() {
  const [status, setStatus] = useState(null); // 'ok' | 'error' | null

  useEffect(() => {
    const check = async () => {
      try {
        const res = await axios.get(`${API_BASE_URL.replace(/\/api\/v\d+$/, '')}/health`);
        const s = res.data?.status;
        setStatus(s === 'ok' || s === 'healthy' ? 'ok' : 'error');
      } catch {
        setStatus('error');
      }
    };
    check();
    const id = setInterval(check, HEALTH_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return { status };
}
