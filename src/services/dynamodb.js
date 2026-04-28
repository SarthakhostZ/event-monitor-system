const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, GetCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const config = require('../config');
const logger = require('../utils/logger');

const client = new DynamoDBClient({
  region: config.aws.region,
  ...(config.dynamodb.endpoint && { endpoint: config.dynamodb.endpoint }),
});

const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

const put = async (tableName, item) => {
  await docClient.send(new PutCommand({ TableName: tableName, Item: item }));
  logger.debug(`DynamoDB put: ${tableName}`, { id: item.id });
  return item;
};

const get = async (tableName, key) => {
  const { Item } = await docClient.send(new GetCommand({ TableName: tableName, Key: key }));
  return Item || null;
};

const update = async (tableName, key, updates) => {
  const entries = Object.entries(updates);
  const ExpressionAttributeNames = {};
  const ExpressionAttributeValues = {};
  const setParts = entries.map(([k, v]) => {
    ExpressionAttributeNames[`#${k}`] = k;
    ExpressionAttributeValues[`:${k}`] = v;
    return `#${k} = :${k}`;
  });

  const { Attributes } = await docClient.send(new UpdateCommand({
    TableName: tableName,
    Key: key,
    UpdateExpression: `SET ${setParts.join(', ')}`,
    ExpressionAttributeNames,
    ExpressionAttributeValues,
    ReturnValues: 'ALL_NEW',
  }));
  return Attributes;
};

const remove = async (tableName, key) => {
  await docClient.send(new DeleteCommand({ TableName: tableName, Key: key }));
};

const query = async (tableName, params) => {
  const { Items = [], LastEvaluatedKey } = await docClient.send(new QueryCommand({ TableName: tableName, ...params }));
  return { items: Items, lastKey: LastEvaluatedKey };
};

const scan = async (tableName, params = {}) => {
  const { Items = [], LastEvaluatedKey } = await docClient.send(new ScanCommand({ TableName: tableName, ...params }));
  return { items: Items, lastKey: LastEvaluatedKey };
};

module.exports = { put, get, update, remove, query, scan };
