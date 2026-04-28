const { v4: uuidv4 } = require('uuid');
const db = require('./dynamodb');
const { validate } = require('../models/Event');
const config = require('../config');
const logger = require('../utils/logger');

const TABLE = config.dynamodb.eventsTable;

const createEvent = async (data) => {
  const event = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    ...data,
  };

  const { error } = validate(event);
  if (error) throw Object.assign(new Error('Validation failed'), { details: error.details, statusCode: 400 });

  return db.put(TABLE, event);
};

const getEvent = async (id, timestamp) => {
  const item = await db.get(TABLE, { id, timestamp });
  if (!item) throw Object.assign(new Error('Event not found'), { statusCode: 404 });
  return item;
};

const listEvents = async ({ source, severity, limit = 20, lastKey } = {}) => {
  const params = { Limit: limit };
  const filters = [];
  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {};

  if (source) {
    filters.push('#source = :source');
    ExpressionAttributeNames['#source'] = 'source';
    ExpressionAttributeValues[':source'] = source;
  }
  if (severity) {
    filters.push('#severity = :severity');
    ExpressionAttributeNames['#severity'] = 'severity';
    ExpressionAttributeValues[':severity'] = severity;
  }
  if (filters.length) {
    params.FilterExpression = filters.join(' AND ');
    params.ExpressionAttributeNames = ExpressionAttributeNames;
    params.ExpressionAttributeValues = ExpressionAttributeValues;
  }
  if (lastKey) params.ExclusiveStartKey = lastKey;

  const { items, lastKey: nextKey } = await db.scan(TABLE, params);
  logger.debug(`listEvents returned ${items.length} items`);
  return { events: items, nextKey };
};

const deleteEvent = async (id, timestamp) => {
  await db.remove(TABLE, { id, timestamp });
};

module.exports = { createEvent, getEvent, listEvents, deleteEvent };
