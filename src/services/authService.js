const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./dynamodb');
const config = require('../config');
const logger = require('../utils/logger');
const { generateToken } = require('../middleware/auth');

const TABLE = config.dynamodb.usersTable;

const register = async ({ email, password, role = 'viewer' }) => {
  const { items } = await db.query(TABLE, {
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
  });
  if (items.length) throw Object.assign(new Error('Email already registered'), { statusCode: 409 });

  const passwordHash = await bcrypt.hash(password, config.bcrypt.saltRounds);
  const now = new Date().toISOString();
  const user = { id: uuidv4(), email, passwordHash, role, createdAt: now, updatedAt: now };
  await db.put(TABLE, user);
  logger.info(`New user registered: ${email}`);
  const { passwordHash: _, ...safe } = user;
  return safe;
};

const login = async ({ email, password }) => {
  const { items } = await db.query(TABLE, {
    IndexName: 'email-index',
    KeyConditionExpression: 'email = :email',
    ExpressionAttributeValues: { ':email': email },
  });
  const user = items[0];
  if (!user) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw Object.assign(new Error('Invalid credentials'), { statusCode: 401 });

  const token = generateToken(user);
  logger.info(`User logged in: ${email}`);
  return { token };
};

const getUserById = async (id) => {
  const user = await db.get(TABLE, { id });
  if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 });
  const { passwordHash: _, ...safe } = user;
  return safe;
};

module.exports = { register, login, getUserById };
