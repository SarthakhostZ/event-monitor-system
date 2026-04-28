const eventService = require('../../src/services/eventService');
const db = require('../../src/services/dynamodb');

jest.mock('../../src/services/dynamodb');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

describe('eventService', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('createEvent', () => {
    it('creates and returns an event with generated id and timestamp', async () => {
      const input = { source: 'api', type: 'user.login', severity: 'low', payload: {} };
      db.put.mockResolvedValue({ id: 'mock-id', timestamp: '2024-01-01T00:00:00.000Z', ...input });

      const event = await eventService.createEvent(input);
      expect(db.put).toHaveBeenCalledTimes(1);
      expect(event.source).toBe('api');
    });

    it('throws a 400 error when severity is invalid', async () => {
      await expect(eventService.createEvent({ source: 'x', type: 'y', severity: 'extreme' }))
        .rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('getEvent', () => {
    it('returns the event when found', async () => {
      const mock = { id: '123', timestamp: 't', source: 'api', type: 'test' };
      db.get.mockResolvedValue(mock);
      const result = await eventService.getEvent('123', 't');
      expect(result).toEqual(mock);
    });

    it('throws 404 when not found', async () => {
      db.get.mockResolvedValue(null);
      await expect(eventService.getEvent('x', 'y')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('listEvents', () => {
    it('returns events and nextKey', async () => {
      db.scan.mockResolvedValue({ items: [{ id: '1' }, { id: '2' }], lastKey: null });
      const result = await eventService.listEvents();
      expect(result.events).toHaveLength(2);
    });

    it('applies source filter when provided', async () => {
      db.scan.mockResolvedValue({ items: [], lastKey: undefined });
      await eventService.listEvents({ source: 'api' });
      const [, params] = db.scan.mock.calls[0];
      expect(params.FilterExpression).toContain('#source');
    });

    it('applies severity filter when provided', async () => {
      db.scan.mockResolvedValue({ items: [], lastKey: undefined });
      await eventService.listEvents({ severity: 'high' });
      const [, params] = db.scan.mock.calls[0];
      expect(params.FilterExpression).toContain('#severity');
    });

    it('combines source AND severity filters', async () => {
      db.scan.mockResolvedValue({ items: [], lastKey: undefined });
      await eventService.listEvents({ source: 'api', severity: 'high' });
      const [, params] = db.scan.mock.calls[0];
      expect(params.FilterExpression).toContain(' AND ');
    });

    it('passes lastKey as ExclusiveStartKey', async () => {
      db.scan.mockResolvedValue({ items: [], lastKey: undefined });
      const lastKey = { id: '1', timestamp: 'ts' };
      await eventService.listEvents({ lastKey });
      const [, params] = db.scan.mock.calls[0];
      expect(params.ExclusiveStartKey).toEqual(lastKey);
    });
  });

  describe('deleteEvent', () => {
    it('calls db.remove with id and timestamp', async () => {
      db.remove.mockResolvedValue(undefined);
      await eventService.deleteEvent('e1', '2026-01-01T00:00:00.000Z');
      expect(db.remove).toHaveBeenCalledWith(
        expect.any(String),
        { id: 'e1', timestamp: '2026-01-01T00:00:00.000Z' },
      );
    });
  });
});
