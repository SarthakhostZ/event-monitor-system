import axios from 'axios';
import { TOKEN_KEY, UNAUTHORIZED_EVENT, API_BASE_URL } from '../utils/constants';

const client = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
});

// Inject JWT token on every request
client.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Unwrap { success, data } envelope; handle 401 auto-logout
client.interceptors.response.use(
  response => response.data.data,
  error => {
    const status = error.response?.status;
    const isLoginEndpoint = error.config?.url?.includes('/auth/login');

    // Auto-logout on 401 for any call except the login attempt itself
    if (status === 401 && !isLoginEndpoint) {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }

    const message =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      'Network error';

    const err = new Error(message);
    err.status = status; // undefined when no response (network error)
    return Promise.reject(err);
  }
);

export default client;
