require('dotenv').config();
const { DynamoDBClient, CreateTableCommand, ListTablesCommand } = require('@aws-sdk/client-dynamodb');

const client = new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' });

const tables = [
  {
    TableName: process.env.DYNAMODB_USERS_TABLE || 'users',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'email', AttributeType: 'S' },
    ],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
    GlobalSecondaryIndexes: [
      {
        IndexName: 'email-index',
        KeySchema: [{ AttributeName: 'email', KeyType: 'HASH' }],
        Projection: { ProjectionType: 'ALL' },
      },
    ],
  },
  {
    TableName: process.env.DYNAMODB_EVENTS_TABLE || 'events',
    AttributeDefinitions: [
      { AttributeName: 'id', AttributeType: 'S' },
      { AttributeName: 'timestamp', AttributeType: 'S' },
    ],
    KeySchema: [
      { AttributeName: 'id', KeyType: 'HASH' },
      { AttributeName: 'timestamp', KeyType: 'RANGE' },
    ],
    BillingMode: 'PAY_PER_REQUEST',
  },
  {
    TableName: process.env.DYNAMODB_ALERTS_TABLE || 'alerts',
    AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
    KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    BillingMode: 'PAY_PER_REQUEST',
  },
];

async function createTables() {
  console.log(`Creating tables in AWS region: ${process.env.AWS_REGION || 'us-east-1'}\n`);
  for (const table of tables) {
    try {
      await client.send(new CreateTableCommand(table));
      console.log(`✓ Created: ${table.TableName}`);
    } catch (err) {
      if (err.name === 'ResourceInUseException') {
        console.log(`- Already exists: ${table.TableName}`);
      } else {
        console.error(`✗ Failed: ${table.TableName} — ${err.message}`);
      }
    }
  }
  const { TableNames } = await client.send(new ListTablesCommand({}));
  console.log('\nAll AWS tables:', TableNames);
}

createTables();
