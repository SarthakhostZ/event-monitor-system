const { v4: uuidv4 } = require('uuid');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const db = require('./dynamodb');
const emailService = require('./emailService');
const config = require('../config');
const logger = require('../utils/logger');

const TABLE = config.dynamodb.alertsTable;
const sns = new SNSClient({ region: config.aws.region });

const createAlert = async ({ eventId, severity, message }) => {
  const alert = {
    id: uuidv4(),
    eventId,
    severity,
    message,
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  await db.put(TABLE, alert);
  logger.info(`Alert created: ${alert.id} [${severity}]`);
  return alert;
};

const publishAlert = async (alert) => {
  if (config.sns.topicArn) {
    await sns.send(new PublishCommand({
      TopicArn: config.sns.topicArn,
      Subject: `[${alert.severity.toUpperCase()}] Event alert`,
      Message: JSON.stringify(alert),
    }));
    logger.info(`Alert published to SNS: ${alert.id}`);
  }

  if (config.email.alertTo) {
    // Map the legacy alert shape to the (event, analysis) signature.
    const eventShape = {
      eventId:     alert.eventId,
      title:       alert.message,
      severity:    alert.severity,
      timestamp:   alert.createdAt,
      analyzedBy:  'rule-engine',
    };
    await emailService.sendAlert(eventShape, {});
  }
};

const acknowledgeAlert = async (id) => {
  return db.update(TABLE, { id }, { status: 'acknowledged', updatedAt: new Date().toISOString() });
};

const resolveAlert = async (id) => {
  return db.update(TABLE, { id }, { status: 'resolved', resolvedAt: new Date().toISOString() });
};

const listAlerts = async ({ status, limit = 20 } = {}) => {
  const params = { Limit: limit };
  if (status) {
    params.FilterExpression = '#status = :status';
    params.ExpressionAttributeNames = { '#status': 'status' };
    params.ExpressionAttributeValues = { ':status': status };
  }
  const { items } = await db.scan(TABLE, params);
  return items;
};

module.exports = { createAlert, publishAlert, acknowledgeAlert, resolveAlert, listAlerts };
