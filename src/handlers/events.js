const eventService = require('../services/eventService');
const alertService = require('../services/alertService');
const logger = require('../utils/logger');

// SQS trigger – processes batched event messages
module.exports.ingest = async (event) => {
  const results = await Promise.allSettled(
    event.Records.map(async (record) => {
      const body = JSON.parse(record.body);
      const created = await eventService.createEvent(body);

      if (['high', 'critical'].includes(created.severity)) {
        const alert = await alertService.createAlert({
          eventId: created.id,
          severity: created.severity,
          message: `Ingested ${created.severity} event from ${created.source}`,
        });
        await alertService.publishAlert(alert);
      }

      logger.info(`Ingested event ${created.id}`);
      return created;
    })
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    logger.error(`${failed.length} records failed during ingestion`);
  }
};
