const { Router } = require('express');
const authService = require('../../services/authService');
const { authenticate } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');
const { registerSchema, loginSchema } = require('../../models/User');
const { success, error } = require('../../utils/response');

const router = Router();

router.post('/register', validate(registerSchema), async (req, res, next) => {
  try {
    const user = await authService.register(req.body);
    success(res, user, 201);
  } catch (err) {
    next(err);
  }
});

router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const result = await authService.login(req.body);
    success(res, result);
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await authService.getUserById(req.user.sub);
    success(res, user);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
