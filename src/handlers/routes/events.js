const { Router } = require('express');
const eventService = require('../../services/eventService');
const alertService = require('../../services/alertService');
const { authenticate, authorize } = require('../../middleware/auth');
const { success } = require('../../utils/response');

const router = Router();

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { source, severity, limit, lastKey } = req.query;
    const result = await eventService.listEvents({ source, severity, limit: Number(limit) || 20, lastKey });
    success(res, result);
  } catch (err) {
    next(err);
  }
});

router.post('/', authorize('admin', 'operator'), async (req, res, next) => {
  try {
    const event = await eventService.createEvent(req.body);

    if (['high', 'critical'].includes(event.severity)) {
      const alert = await alertService.createAlert({
        eventId: event.id,
        severity: event.severity,
        message: `${event.severity.toUpperCase()} event from ${event.source}: ${event.type}`,
      });
      await alertService.publishAlert(alert);
    }

    success(res, event, 201);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const event = await eventService.getEvent(req.params.id, req.query.timestamp);
    success(res, event);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    await eventService.deleteEvent(req.params.id, req.query.timestamp);
    success(res, { deleted: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
