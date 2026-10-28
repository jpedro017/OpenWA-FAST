import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import request from 'supertest';
import type { Server } from 'node:http';
import { ChatScopeService } from '../auth/chat-scope.service';
import { CHAT_SCOPED_KEY, REQUIRED_ROLE_KEY } from '../auth/decorators/auth.decorators';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import type { AuthService } from '../auth/auth.service';
import type { AuditService } from '../audit/audit.service';
import { IdempotentTextController } from './idempotent-text.controller';
import { IdempotentTextService } from './idempotent-text.service';
import { IdempotentTextMessageDto } from './dto/idempotent-text.dto';

describe('IdempotentTextController', () => {
  const sends = { send: jest.fn(), receipt: jest.fn() };
  const controller = new IdempotentTextController(sends as unknown as IdempotentTextService, new ChatScopeService());

  beforeEach(() => {
    sends.send.mockReset();
    sends.receipt.mockReset();
  });

  it('probes support without entering the send path', async () => {
    expect(await controller.protocol('session', '62811@c.us')).toEqual({ protocol: 'openwa-idempotent-text-v1' });
    expect(sends.send).not.toHaveBeenCalled();
  });

  it('requires an explicit chat for a chat-restricted key', async () => {
    const key = { allowedChats: ['62811@c.us'] } as ApiKey;
    await expect(controller.protocol('session', '  ')).rejects.toThrow(BadRequestException);
    await expect(controller.protocol('session', undefined, key)).rejects.toThrow(BadRequestException);
    expect((await controller.protocol('session', '62811@c.us', key)).protocol).toBe('openwa-idempotent-text-v1');
  });

  it('looks up a receipt only when explicitly requested, without sending', async () => {
    sends.receipt.mockResolvedValue({ requestId: 'key', messageId: 'wa-id', timestamp: 123 });
    expect(await controller.protocol('session', '62811@c.us', undefined, 'wa-id')).toEqual({
      protocol: 'openwa-idempotent-text-v1',
      receipt: { requestId: 'key', messageId: 'wa-id', timestamp: 123 },
    });
    expect(sends.receipt).toHaveBeenCalledWith('session', '62811@c.us', 'wa-id');
    expect(sends.send).not.toHaveBeenCalled();
  });

  it('declares the chat fences and operator-level send permission used by the API guard', () => {
    /* eslint-disable @typescript-eslint/unbound-method -- Reflect inspects metadata; these methods are never invoked unbound. */
    for (const handler of [controller.protocol, controller.send])
      expect(Reflect.getMetadata(CHAT_SCOPED_KEY, handler)).toBe('fenced');
    expect(Reflect.getMetadata(REQUIRED_ROLE_KEY, controller.send)).toBe(ApiKeyRole.OPERATOR);
    /* eslint-enable @typescript-eslint/unbound-method */
  });

  it.each(['', ' ', 'x'.repeat(201)])('rejects an invalid requestId before reserving a send: %p', async requestId => {
    const dto = plainToInstance(IdempotentTextMessageDto, { requestId, chatId: '62811@c.us', text: 'Hello' });
    expect((await validate(dto)).some(error => error.property === 'requestId')).toBe(true);
    expect(sends.send).not.toHaveBeenCalled();
  });

  it('validates the inherited send DTO and carries the exact receipt over HTTP', async () => {
    const module = await Test.createTestingModule({
      controllers: [IdempotentTextController],
      providers: [{ provide: IdempotentTextService, useValue: sends }, ChatScopeService],
    }).compile();
    const app = module.createNestApplication();
    const auth = {
      validateApiKey: jest.fn((_key: string, _ip: string, sessionId: string) => {
        if (sessionId !== 'session') throw new ForbiddenException('Session outside key scope');
        return Promise.resolve({ id: 'key', role: ApiKeyRole.OPERATOR, allowedChats: ['62811@c.us'] });
      }),
      hasPermission: () => true,
    };
    app.useGlobalGuards(
      new ApiKeyGuard(
        auth as unknown as AuthService,
        new Reflector(),
        new ConfigService(),
        { logWarn: () => Promise.resolve() } as unknown as AuditService,
        new ChatScopeService(),
      ),
    );
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const server = app.getHttpServer() as Server;
    const path = '/api/sessions/session/messages/send-text-idempotent';
    try {
      await request(server).get(`${path}?chatId=62811@c.us`).expect(401);
      await request(server).get(`${path}?chatId=62812@c.us`).set('X-API-Key', 'key').expect(403);
      await request(server)
        .get(`${path.replace('/session/', '/other/')}?chatId=62811@c.us`)
        .set('X-API-Key', 'key')
        .expect(403);
      await request(server).get(`${path}?chatId=62811@c.us`).set('X-API-Key', 'key').expect(200);
      sends.receipt.mockResolvedValue({ requestId: 'key', messageId: 'wa-id', timestamp: 123 });
      const proof = await request(server)
        .get(`${path}?chatId=62811@c.us&messageId=wa-id`)
        .set('X-API-Key', 'key')
        .expect(200);
      expect(proof.body).toEqual({
        protocol: 'openwa-idempotent-text-v1',
        receipt: { requestId: 'key', messageId: 'wa-id', timestamp: 123 },
      });
      expect(sends.receipt).toHaveBeenCalledWith('session', '62811@c.us', 'wa-id');
      await request(server)
        .post(path)
        .set('X-API-Key', 'key')
        .send({ requestId: 'key', chatId: '62812@c.us', text: 'Hello' })
        .expect(403);
      await request(server)
        .post(path)
        .set('X-API-Key', 'key')
        .send({ requestId: 'key', chatId: '62811@c.us' })
        .expect(400);
      expect(sends.send).not.toHaveBeenCalled();
      sends.send.mockResolvedValue({ status: 'sent', messageId: 'wa-receipt', timestamp: 123 });
      const response = await request(server)
        .post(path)
        .set('X-API-Key', 'key')
        .send({ requestId: 'key', chatId: '62811@c.us', text: 'Hello' })
        .expect(200);
      expect(response.body).toEqual({ status: 'sent', messageId: 'wa-receipt', timestamp: 123 });
      expect(sends.send).toHaveBeenCalledWith('session', expect.objectContaining({ requestId: 'key', text: 'Hello' }));
    } finally {
      await app.close();
    }
  });
});
