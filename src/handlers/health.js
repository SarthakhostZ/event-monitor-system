const { DynamoDBClient, ListTablesCommand } = require('@aws-sdk/client-dynamodb');
const config = require('../config');
const logger = require('../utils/logger');

module.exports.check = async () => {
  const client = new DynamoDBClient({ region: config.aws.region });
  try {
    await client.send(new ListTablesCommand({}));
    logger.info('Health check passed – DynamoDB reachable');
    return { statusCode: 200, body: JSON.stringify({ status: 'healthy' }) };
  } catch (err) {
    logger.error('Health check failed', { error: err.message });
    return { statusCode: 503, body: JSON.stringify({ status: 'unhealthy', error: err.message }) };
  }
};
