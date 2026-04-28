import client from './client';

export async function listEvents({ severity, source, type, limit = 50, lastKey } = {}) {
  const params = {};
  if (severity) params.severity = severity;
  if (source) params.source = source;
  if (type) params.type = type;
  if (limit) params.limit = limit;
  if (lastKey) params.lastKey = lastKey;
  return client.get('/events', { params });
}

export async function getEvent(id, timestamp) {
  const params = timestamp ? { timestamp } : {};
  return client.get(`/events/${id}`, { params });
}

export async function deleteEvent(id, timestamp) {
  const params = timestamp ? { timestamp } : {};
  return client.delete(`/events/${id}`, { params });
}

export async function createEvent(payload) {
  return client.post('/events', payload);
}
