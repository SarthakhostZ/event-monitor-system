const Joi = require('joi');

const eventSchema = Joi.object({
  id: Joi.string().uuid().required(),
  source: Joi.string().max(100).required(),
  type: Joi.string().max(100).required(),
  severity: Joi.string().valid('low', 'medium', 'high', 'critical').default('low'),
  payload: Joi.object().default({}),
  metadata: Joi.object().default({}),
  timestamp: Joi.string().isoDate().required(),
  ttl: Joi.number().integer().optional(),
});

const validate = (data) => eventSchema.validate(data, { abortEarly: false });

module.exports = { eventSchema, validate };
