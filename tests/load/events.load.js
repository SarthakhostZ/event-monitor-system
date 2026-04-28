/**
 * Artillery load-test script for the events endpoint.
 * Run with:
 *   npx artillery run tests/load/events.load.js
 */
module.exports = {
  config: {
    target: process.env.LOAD_TEST_TARGET || 'http://localhost:3000',
    phases: [
      { duration: 30, arrivalRate: 5, name: 'Warm-up' },
      { duration: 60, arrivalRate: 20, name: 'Sustained load' },
      { duration: 30, arrivalRate: 50, name: 'Spike' },
    ],
    defaults: {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LOAD_TEST_TOKEN || 'replace_with_valid_token'}`,
      },
    },
  },
  scenarios: [
    {
      name: 'List events',
      flow: [{ get: { url: '/api/v1/events' } }],
    },
    {
      name: 'Create event',
      flow: [
        {
          post: {
            url: '/api/v1/events',
            json: {
              source: 'load-test',
              type: 'test.event',
              severity: 'low',
              payload: { test: true },
            },
          },
        },
      ],
    },
  ],
};
