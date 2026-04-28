const { createLogger, format, transports } = require('winston');
const { app } = require('../config');

const logger = createLogger({
  level: app.logLevel,
  format: format.combine(
    format.timestamp(),
    format.errors({ stack: true }),
    app.env === 'production'
      ? format.json()
      : format.combine(format.colorize(), format.simple())
  ),
  transports: [new transports.Console()],
});

module.exports = logger;
