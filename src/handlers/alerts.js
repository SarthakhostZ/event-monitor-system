const alertService = require('../services/alertService');
const logger = require('../utils/logger');

// SNS trigger – processes alert notifications
module.exports.process = async (event) => {
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.Sns.Message);
      logger.info(`Processing SNS alert: ${message.id}`);

      if (message.severity === 'critical') {
        // Additional critical-alert handling (paging, escalation) can go here
        logger.warn(`Critical alert requires immediate attention: ${message.id}`);
      }
    } catch (err) {
      logger.error('Failed to process SNS alert record', { error: err.message });
    }
  }
};
