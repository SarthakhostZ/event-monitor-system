const logger = require('../utils/logger');

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  logger.error(err.message, { stack: err.stack, path: req.path });
  res.status(statusCode).json({
    success: false,
    message: statusCode === 500 ? 'Internal server error' : err.message,
    ...(err.details && { details: err.details }),
  });
};

module.exports = { errorHandler };
