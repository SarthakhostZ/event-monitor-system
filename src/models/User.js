const Joi = require('joi');

const userSchema = Joi.object({
  id: Joi.string().uuid().required(),
  email: Joi.string().email().required(),
  passwordHash: Joi.string().required(),
  role: Joi.string().valid('admin', 'operator', 'viewer').default('viewer'),
  createdAt: Joi.string().isoDate().required(),
  updatedAt: Joi.string().isoDate().required(),
});

const registerSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  role: Joi.string().valid('admin', 'operator', 'viewer').default('viewer'),
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required(),
});

module.exports = { userSchema, registerSchema, loginSchema };
