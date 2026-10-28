import 'reflect-metadata';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { IdempotentTextService } from './idempotent-text.service';
import { OutboundTextRequest } from './entities/outbound-text-request.entity';
import { MessageService } from './message.service';
import { IdempotentTextMessageDto } from './dto/idempotent-text.dto';

const message: IdempotentTextMessageDto = { requestId: 'turn-1', chatId: '5511999999999@c.us', text: 'Bom dia!' };
const receipt = { messageId: 'true_chat_provider-id', timestamp: 1793192400 };

describe('IdempotentTextService with durable SQLite reservations', () => {
  let directory: string;
  let database: string;
  let ds: DataSource;
  let requests: Repository<OutboundTextRequest>;
  let sendText: jest.Mock;
  let service: IdempotentTextService;

  const buildService = () => new IdempotentTextService(requests, { sendText } as unknown as MessageService);
  const open = async (synchronize: boolean) => {
    ds = new DataSource({ type: 'better-sqlite3', database, entities: [OutboundTextRequest], synchronize });
    await ds.initialize();
    requests = ds.getRepository(OutboundTextRequest);
    service = buildService();
  };

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'openwa-idempotent-text-'));
    database = join(directory, 'requests.sqlite');
    sendText = jest.fn().mockResolvedValue(receipt);
    await open(true);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (ds?.isInitialized) await ds.destroy();
    rmSync(directory, { recursive: true, force: true });
  });

  it('allows only one concurrent caller into the canonical sender', async () => {
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const release = new Promise<void>(resolve => {
      finish = resolve;
    });
    sendText.mockImplementation(async () => {
      enter();
      await release;
      return receipt;
    });
    const first = service.send('session-1', message);
    await entered;
    const repeated = await Promise.all(Array.from({ length: 12 }, () => buildService().send('session-1', message)));
    expect(repeated.every(result => result.status === 'pending')).toBe(true);
    expect(sendText).toHaveBeenCalledTimes(1);
    finish();
    await expect(first).resolves.toEqual({ status: 'sent', ...receipt });
    expect(await requests.count()).toBe(1);
  });

  it('replays the confirmed receipt after a lost HTTP response and after restarting the database connection', async () => {
    await service.send('session-1', message); // The caller loses this result at the proxy.
    await ds.destroy();
    await open(false);
    await expect(service.send('session-1', message)).resolves.toEqual({ status: 'sent', ...receipt });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('reads a receipt only for the matching session, chat and confirmed provider ID', async () => {
    await service.send('session-1', message);
    await expect(service.receipt('session-1', message.chatId, receipt.messageId)).resolves.toEqual({
      requestId: message.requestId,
      ...receipt,
    });
    await expect(service.receipt('another-session', message.chatId, receipt.messageId)).resolves.toBeNull();
    await expect(service.receipt('session-1', 'another-chat', receipt.messageId)).resolves.toBeNull();
    await expect(service.receipt('session-1', message.chatId, 'another-message')).resolves.toBeNull();
    await requests.update({ sessionId: 'session-1', requestId: message.requestId }, { status: 'pending' });
    await expect(service.receipt('session-1', message.chatId, receipt.messageId)).resolves.toBeNull();
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it.each([
    { text: 'Outra resposta' },
    { chatId: '5511888888888@c.us' },
    { mentions: ['5511888888888@c.us'] },
    { linkPreview: false },
    { quotedMessageId: 'another-message' },
  ])('permanently rejects a reused key with changed payload %p', async change => {
    await service.send('session-1', message);
    await expect(service.send('session-1', { ...message, ...change })).rejects.toThrow(ConflictException);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('hashes nested object keys canonically while preserving their values', async () => {
    const preview = { url: 'https://example.com/', title: 'Example', description: 'Description' };
    await service.send('session-1', { ...message, customLinkPreview: preview });
    await expect(
      service.send('session-1', {
        ...message,
        customLinkPreview: {
          description: 'Description',
          title: 'Example',
          url: 'https://example.com/',
        },
      }),
    ).resolves.toEqual({ status: 'sent', ...receipt });
    await expect(
      service.send('session-1', {
        ...message,
        customLinkPreview: {
          ...preview,
          description: 'Changed',
        },
      }),
    ).rejects.toThrow(ConflictException);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('scopes identical request keys to their session', async () => {
    await service.send('session-1', message);
    await service.send('session-2', message);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(await requests.count()).toBe(2);
  });

  it('preserves an ambiguous engine outcome across restart without entering the sender again', async () => {
    sendText.mockRejectedValue(new Error('The engine accepted the message but the connection closed'));
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'ambiguous' });
    await ds.destroy();
    await open(false);
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'ambiguous' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the sender when the durable reservation cannot be written', async () => {
    await ds.query(
      "CREATE TRIGGER reject_reservation BEFORE INSERT ON outbound_text_requests BEGIN SELECT RAISE(FAIL, 'disk full'); END",
    );
    await expect(service.send('session-1', message)).rejects.toThrow('disk full');
    expect(sendText).not.toHaveBeenCalled();
    expect(await requests.count()).toBe(0);
  });

  it('never re-executes a send when both terminal writes fail after its receipt', async () => {
    await ds.query(
      "CREATE TRIGGER reject_outcome BEFORE UPDATE ON outbound_text_requests BEGIN SELECT RAISE(FAIL, 'disk full after send'); END",
    );
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'ambiguous' });
    jest.restoreAllMocks();
    expect((await requests.findOneByOrFail({ sessionId: 'session-1', requestId: message.requestId })).status).toBe(
      'pending',
    );
    await ds.destroy();
    await open(false);
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'pending' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('refuses a send before any engine call when another SQLite transaction owns the connection', async () => {
    const runner = ds.createQueryRunner();
    await runner.startTransaction();
    await expect(service.send('session-1', message)).rejects.toThrow(ServiceUnavailableException);
    expect(sendText).not.toHaveBeenCalled();
    expect(await requests.count()).toBe(0);
    await runner.rollbackTransaction();
    await runner.release();
    await expect(service.send('session-1', message)).resolves.toEqual({ status: 'sent', ...receipt });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('does not publish an uncommitted SENT outcome when another transaction starts during the engine await', async () => {
    const runner = ds.createQueryRunner();
    sendText.mockImplementationOnce(async () => {
      await runner.startTransaction();
      return receipt;
    });
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'ambiguous' });
    expect((await requests.findOneByOrFail({ sessionId: 'session-1', requestId: message.requestId })).status).toBe(
      'pending',
    );
    await runner.rollbackTransaction();
    await runner.release();
    await ds.destroy();
    await open(false);
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'pending' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it('refuses to expose a receipt read from an ambient transaction that can still roll back', async () => {
    await service.send('session-1', message);
    const runner = ds.createQueryRunner();
    await runner.startTransaction();
    await expect(service.receipt('session-1', message.chatId, receipt.messageId)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await runner.rollbackTransaction();
    await runner.release();
    await expect(service.receipt('session-1', message.chatId, receipt.messageId)).resolves.toEqual({
      requestId: message.requestId,
      ...receipt,
    });
  });

  it('retains the reservation when the engine reports an invalid receipt', async () => {
    sendText.mockResolvedValue({ messageId: '', timestamp: 123 });
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'ambiguous' });
    await expect(service.send('session-1', message)).resolves.toMatchObject({ status: 'ambiguous' });
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
