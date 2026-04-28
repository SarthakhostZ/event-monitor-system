const { Router } = require('express');
const alertService = require('../../services/alertService');
const { authenticate, authorize } = require('../../middleware/auth');
const { success } = require('../../utils/response');

const router = Router();

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const alerts = await alertService.listAlerts({ status: req.query.status });
    success(res, alerts);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/acknowledge', authorize('admin', 'operator'), async (req, res, next) => {
  try {
    const alert = await alertService.acknowledgeAlert(req.params.id);
    success(res, alert);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/resolve', authorize('admin', 'operator'), async (req, res, next) => {
  try {
    const alert = await alertService.resolveAlert(req.params.id);
    success(res, alert);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
