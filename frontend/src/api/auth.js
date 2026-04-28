import client from './client';

export async function login({ email, password }) {
  return client.post('/auth/login', { email, password });
}

export async function getMe() {
  return client.get('/auth/me');
}
