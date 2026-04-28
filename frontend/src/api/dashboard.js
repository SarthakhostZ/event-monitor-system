import client from './client';

export async function getDashboardStats(window = '24h') {
  return client.get('/dashboard/stats', { params: { window } });
}

export async function getDashboardTrends(window = '24h') {
  return client.get('/dashboard/trends', { params: { window } });
}
