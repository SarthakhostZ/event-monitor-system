const express = require('express');
const serverless = require('serverless-http');
const { securityStack } = require('../middleware/security');
const { rateLimiter }   = require('../middleware/rateLimiter');
const { errorHandler }  = require('../middleware/errorHandler');

// Route imports
const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const alertRoutes = require('./routes/alerts');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(securityStack);
app.use(rateLimiter());

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/events', eventRoutes);
app.use('/api/v1/alerts', alertRoutes);

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }));
app.use(errorHandler);

module.exports.handler = serverless(app);
module.exports.app = app; // for tests
