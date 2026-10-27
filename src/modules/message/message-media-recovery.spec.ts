import { NotFoundException } from '@nestjs/common';
import { FindOperator, type Repository } from 'typeorm';
import { MessageService } from './message.service';
import { Message, MessageDirection, MessageStatus } from './entities/message.entity';
import type { EngineRegistry } from '../../engine/engine-registry.service';
import type { MessageProjector } from '../session/message-projector.service';
import type { HookManager } from '../../core/hooks';
import type { LidMappingStoreService } from '../../engine/identity/lid-mapping-store.service';
import type { SendPacingService } from './send-pacing.service';
import type { MessageSendService } from './message-send.service';
import type { ChatMediaArchiveService } from '../chat-media/chat-media-archive.service';
import { EngineNotSupportedError } from '../../common/errors/engine-not-supported.error';

function fixture() {
  const row = Object.assign(new Message(), {
    id: 'row-id',
    waMessageId: 'false_111@lid_NATIVE',
    sessionId: 'session',
    chatId: '111@lid',
    type: 'ptt',
    direction: MessageDirection.INCOMING,
    status: MessageStatus.DELIVERED,
    body: 'preserve',
    createdAt: new Date('2026-10-27T10:00:00Z'),
    metadata: { media: { mimetype: 'audio/ogg', omitted: true }, reactions: ['preserve'] },
  });
  const state = {
    missing: false,
    oldEngine: false,
    duringDownload: null as (() => void) | null,
    duringArchive: null as (() => void) | null,
  };
  const repository = {
    findOne: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if (state.missing || where.sessionId !== row.sessionId || where.waMessageId !== row.waMessageId)
        return Promise.resolve(null);
      const chats = (where.chatId as FindOperator<string[]>).value;
      if (!chats.includes(row.chatId) || (where.id && where.id !== row.id) || (where.type && row.type === 'revoked'))
        return Promise.resolve(null);
      return Promise.resolve(structuredClone(row));
    }),
    update: jest.fn(),
    save: jest.fn(),
  };
  const media = { mimetype: 'audio/ogg', data: Buffer.from('synthetic audio').toString('base64') };
  const engine = {
    getMessageMedia: jest.fn().mockImplementation(() => {
      state.duringDownload?.();
      return Promise.resolve(media);
    }),
    getChatHistory: jest.fn(),
    markRead: jest.fn(),
  };
  const registry = { require: jest.fn().mockImplementation(() => (state.oldEngine ? {} : engine)) };
  const projector = { process: jest.fn(), recordRevoke: jest.fn() };
  const hookManager = { emit: jest.fn() };
  const archive = {
    getMedia: jest.fn().mockResolvedValue(null),
    archive: jest.fn().mockImplementation(() => {
      state.duringArchive?.();
      return Promise.resolve(null);
    }),
  };
  const subject = new MessageService(
    repository as unknown as Repository<Message>,
    registry as unknown as EngineRegistry,
    projector as unknown as MessageProjector,
    hookManager as unknown as HookManager,
    {
      findPhoneForLid: () => Promise.resolve('628111'),
      findLidsForPhone: () => Promise.resolve(['111']),
    } as unknown as LidMappingStoreService,
    {} as SendPacingService,
    {} as MessageSendService,
    archive as unknown as ChatMediaArchiveService,
  );
  return {
    row,
    state,
    repository,
    engine,
    registry,
    projector,
    hookManager,
    archive,
    media,
    subject,
    run: (recover = true) =>
      subject.getChatMedia('session', '628111@c.us', 'false_111@lid_NATIVE', recover ? { recover: true } : undefined),
  };
}

describe('MessageService opt-in media recovery', () => {
  it('default stored-media read keeps the legacy404 and never touches the live engine', async () => {
    const h = fixture();
    await expect(h.run(false)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.registry.require).not.toHaveBeenCalled();
    expect(h.engine.getMessageMedia).not.toHaveBeenCalled();
  });

  it('recovers only the target within expanded chat ids and never synchronizes history or messages', async () => {
    const h = fixture();
    const metadata = structuredClone(h.row.metadata);
    const timestamp = h.row.createdAt;
    await expect(h.run()).resolves.toEqual({ buffer: Buffer.from('synthetic audio'), mimetype: 'audio/ogg' });
    expect(h.engine.getMessageMedia).toHaveBeenCalledWith(
      expect.arrayContaining(['628111@c.us', '111@lid']),
      h.row.waMessageId,
      undefined,
    );
    expect(h.engine.getChatHistory).not.toHaveBeenCalled();
    expect(h.engine.markRead).not.toHaveBeenCalled();
    expect(h.projector.process).not.toHaveBeenCalled();
    expect(h.hookManager.emit).not.toHaveBeenCalled();
    expect(h.repository.update).not.toHaveBeenCalled();
    expect(h.repository.save).not.toHaveBeenCalled();
    expect(h.row.metadata).toEqual(metadata);
    expect(h.row.createdAt).toBe(timestamp);
    expect(h.archive.archive).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'revoked', 'other-session', 'other-chat'])(
    'refuses %s before reaching the live engine',
    async kind => {
      const h = fixture();
      if (kind === 'missing') h.state.missing = true;
      if (kind === 'revoked') h.row.type = 'revoked';
      if (kind === 'other-session') h.row.sessionId = 'other';
      if (kind === 'other-chat') h.row.chatId = 'unrelated@lid';
      await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
      expect(h.engine.getMessageMedia).not.toHaveBeenCalled();
    },
  );

  it('returns501 for an older plugin without the optional capability', async () => {
    const h = fixture();
    h.state.oldEngine = true;
    await expect(h.run()).rejects.toBeInstanceOf(EngineNotSupportedError);
  });

  it.each(['omitted', 'missing-data', 'URL'])('does not treat %s as recovered bytes', async state => {
    const h = fixture();
    const invalid =
      state === 'omitted'
        ? { omitted: true, mimetype: 'audio/ogg' }
        : { mimetype: 'audio/ogg', data: state === 'URL' ? 'https://remote.example' : '' };
    h.engine.getMessageMedia.mockResolvedValue(invalid);
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
    expect(h.archive.archive).not.toHaveBeenCalled();
  });

  it.each(['download', 'archive'])('revocation during %s withdraws the response bytes', async phase => {
    const h = fixture();
    const revoke = () => {
      h.row.type = 'revoked';
    };
    if (phase === 'download') h.state.duringDownload = revoke;
    else h.state.duringArchive = revoke;
    await expect(h.run()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps recovered content inert when the sender declares an active MIME', async () => {
    const h = fixture();
    h.media.mimetype = 'image/svg+xml';
    expect((await h.run()).mimetype).toBe('application/octet-stream');
  });
});
