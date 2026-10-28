import { DataSource } from 'typeorm';
import { AddOutboundTextRequests1787000000000 } from './migrations/1787000000000-AddOutboundTextRequests';
import { OutboundTextRequest } from '../modules/message/entities/outbound-text-request.entity';

describe('AddOutboundTextRequests migration on real SQLite', () => {
  let ds: DataSource;
  const migration = new AddOutboundTextRequests1787000000000();

  beforeEach(async () => {
    ds = new DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [OutboundTextRequest] });
    await ds.initialize();
  });
  afterEach(async () => {
    if (ds.isInitialized) await ds.destroy();
  });

  it('creates an idempotent schema compatible with the entity and enforces the composite send identity', async () => {
    const runner = ds.createQueryRunner();
    await migration.up(runner);
    await migration.up(runner);
    const repo = ds.getRepository(OutboundTextRequest);
    const request = { sessionId: 'session-1', requestId: 'turn-1', chatId: '5511999999999@c.us', payloadHash: 'hash' };
    await repo.insert(request);
    await expect(repo.insert(request)).rejects.toThrow(/UNIQUE/);
    await repo.insert({ ...request, sessionId: 'session-2' });
    expect(await repo.count()).toBe(2);
    expect(await repo.findOneByOrFail({ sessionId: request.sessionId, requestId: request.requestId })).toMatchObject({
      ...request,
      status: 'pending',
      messageId: null,
      timestamp: null,
      error: null,
    });
    const changes = await ds.driver.createSchemaBuilder().log();
    expect(changes.upQueries).toEqual([]);
    await migration.down(runner);
    expect(await runner.hasTable('outbound_text_requests')).toBe(false);
  });
});
