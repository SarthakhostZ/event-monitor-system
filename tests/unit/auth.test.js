const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const authService = require('../../src/services/authService');
const db = require('../../src/services/dynamodb');

jest.mock('../../src/services/dynamodb');

describe('authService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('register', () => {
    it('creates a user and returns safe fields (no passwordHash)', async () => {
      db.query.mockResolvedValue({ items: [] });
      db.put.mockResolvedValue();

      const user = await authService.register({ email: 'test@example.com', password: 'secret123' });
      expect(user.email).toBe('test@example.com');
      expect(user.passwordHash).toBeUndefined();
    });

    it('throws 409 when email already exists', async () => {
      db.query.mockResolvedValue({ items: [{ id: 'x', email: 'test@example.com' }] });
      await expect(authService.register({ email: 'test@example.com', password: 'secret123' }))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe('login', () => {
    it('returns a JWT token on valid credentials', async () => {
      const hash = await bcrypt.hash('secret123', 1);
      db.query.mockResolvedValue({ items: [{ id: 'u1', email: 'a@b.com', passwordHash: hash, role: 'viewer' }] });

      const { token } = await authService.login({ email: 'a@b.com', password: 'secret123' });
      const decoded = jwt.decode(token);
      expect(decoded.email).toBe('a@b.com');
    });

    it('throws 401 for wrong password', async () => {
      const hash = await bcrypt.hash('correct', 1);
      db.query.mockResolvedValue({ items: [{ id: 'u1', email: 'a@b.com', passwordHash: hash, role: 'viewer' }] });
      await expect(authService.login({ email: 'a@b.com', password: 'wrong' }))
        .rejects.toMatchObject({ statusCode: 401 });
    });
  });
});
