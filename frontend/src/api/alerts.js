import client from './client';

export async function listAlerts({ status } = {}) {
  const params = {};
  if (status) params.status = status;
  return client.get('/alerts', { params });
}

export async function acknowledgeAlert(id) {
  return client.patch(`/alerts/${id}/acknowledge`);
}

export async function resolveAlert(id) {
  return client.patch(`/alerts/${id}/resolve`);
}
