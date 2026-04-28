const Joi = require('joi');

const alertSchema = Joi.object({
  id: Joi.string().uuid().required(),
  eventId: Joi.string().uuid().required(),
  severity: Joi.string().valid('low', 'medium', 'high', 'critical').required(),
  message: Joi.string().max(500).required(),
  status: Joi.string().valid('open', 'acknowledged', 'resolved').default('open'),
  notifiedAt: Joi.string().isoDate().optional(),
  resolvedAt: Joi.string().isoDate().optional(),
  createdAt: Joi.string().isoDate().required(),
});

const validate = (data) => alertSchema.validate(data, { abortEarly: false });

module.exports = { alertSchema, validate };
