const { error } = require('../utils/response');

const validate = (schema, target = 'body') => (req, res, next) => {
  const { error: err, value } = schema.validate(req[target], { abortEarly: false, stripUnknown: true });
  if (err) {
    const details = err.details.map((d) => d.message);
    return error(res, 'Validation failed', 400, details);
  }
  req[target] = value;
  next();
};

module.exports = { validate };
