require('dotenv').config();

module.exports = {
  app: {
    name: process.env.APP_NAME || 'event-monitor-system',
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.APP_PORT, 10) || 3000,
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    accountId: process.env.AWS_ACCOUNT_ID,
  },

  dynamodb: {
    eventsTable: process.env.DYNAMODB_EVENTS_TABLE || 'events',
    usersTable: process.env.DYNAMODB_USERS_TABLE || 'users',
    alertsTable: process.env.DYNAMODB_ALERTS_TABLE || 'alerts',
    metricsTable: process.env.DYNAMODB_METRICS_TABLE || 'MetricsTable',
    endpoint: process.env.DYNAMODB_ENDPOINT || undefined,
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'change_me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  bcrypt: {
    saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS, 10) || 12,
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  email: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'noreply@example.com',
    alertTo: process.env.ALERT_EMAIL_TO,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60_000,
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
  },

  sns: {
    topicArn: process.env.SNS_TOPIC_ARN,
  },

  sqs: {
    queueUrl: process.env.SQS_QUEUE_URL,
  },

  s3: {
    bucketName: process.env.S3_BUCKET_NAME,
  },
};
