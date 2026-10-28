import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'node:crypto';
import { Repository } from 'typeorm';
import { isUniqueViolation } from '../../common/utils/db-errors';
import { createLogger } from '../../common/services/logger.service';
import { MessageService } from './message.service';
import { OutboundTextRequest } from './entities/outbound-text-request.entity';
import { IdempotentTextMessageDto, IdempotentTextReceiptDto, IdempotentTextResultDto } from './dto/idempotent-text.dto';

type RequestIdentity = Pick<OutboundTextRequest, 'sessionId' | 'requestId'>;
type StoredOutcome = Pick<OutboundTextRequest, 'status' | 'messageId' | 'timestamp' | 'error'>;
type StoredReservation = StoredOutcome & Pick<OutboundTextRequest, 'chatId' | 'payloadHash'>;

interface SynchronousSqliteDatabase {
  readonly inTransaction: boolean;
  prepare(sql: string): {
    run(...parameters: unknown[]): { changes: number };
    get(...parameters: unknown[]): unknown;
  };
}

/** JSON request objects have no cycles; sorting object keys makes harmless key order irrelevant. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function savedOutcome(row: StoredOutcome): IdempotentTextResultDto {
  if (row.status === 'sent' && row.messageId && row.timestamp !== null)
    return { status: 'sent', messageId: row.messageId, timestamp: row.timestamp };
  return {
    status: row.status === 'sent' ? 'ambiguous' : row.status,
    error: row.error ?? 'The original send has no confirmed receipt and will not be executed again.',
  };
}

/** A successful insert is the ONLY authority to enter the canonical send path. No lease/TTL replay. */
@Injectable()
export class IdempotentTextService {
  private readonly logger = createLogger('IdempotentTextService');

  constructor(
    @InjectRepository(OutboundTextRequest, 'data') private readonly requests: Repository<OutboundTextRequest>,
    private readonly messages: MessageService,
  ) {}

  /** Read-only proof for an own-send echo; never reserves or repeats a send. */
  async receipt(sessionId: string, chatId: string, messageId: string): Promise<IdempotentTextReceiptDto | null> {
    const sqlite = this.autocommitSqlite();
    const row = sqlite
      ? (sqlite
          .prepare(
            'SELECT "requestId", "messageId", "timestamp" FROM "outbound_text_requests" WHERE "sessionId" = ? AND "chatId" = ? AND "messageId" = ? AND "status" = ?',
          )
          .get(sessionId, chatId, messageId, 'sent') as IdempotentTextReceiptDto | undefined)
      : await this.requests.findOneBy({ sessionId, chatId, messageId, status: 'sent' });
    if (!row?.messageId || row.timestamp === null) return null;
    return { requestId: row.requestId, messageId: row.messageId, timestamp: row.timestamp };
  }

  async send(sessionId: string, dto: IdempotentTextMessageDto): Promise<IdempotentTextResultDto> {
    const { requestId, ...message } = dto;
    const identity = { sessionId, requestId };
    const payloadHash = createHash('sha256').update(canonicalJson(message)).digest('hex');
    const existing = await this.reserve({ ...identity, chatId: message.chatId, payloadHash });
    if (existing) return existing;
    try {
      const receipt = await this.messages.sendText(sessionId, message);
      const messageId = receipt.messageId?.trim();
      if (!messageId || !Number.isFinite(receipt.timestamp))
        throw new Error('The engine returned no valid message receipt.');
      const changed = await this.persistOutcome(identity, {
        status: 'sent',
        messageId,
        timestamp: receipt.timestamp,
        error: null,
      });
      if (changed !== 1) throw new Error('The confirmed send receipt could not be persisted.');
      return { status: 'sent', messageId, timestamp: receipt.timestamp };
    } catch (error) {
      return this.markAmbiguous(identity, error);
    }
  }

  private async reserve(
    request: Pick<OutboundTextRequest, 'sessionId' | 'requestId' | 'chatId' | 'payloadHash'>,
  ): Promise<IdempotentTextResultDto | null> {
    const { sessionId, requestId, chatId, payloadHash } = request;
    // No await may separate this check from the native statement: SQLite's QueryRunner is shared,
    // so an unrelated async import transaction could otherwise absorb and roll back the reservation.
    const sqlite = this.autocommitSqlite();
    try {
      if (sqlite) {
        sqlite
          .prepare(
            'INSERT INTO "outbound_text_requests" ("sessionId", "requestId", "chatId", "payloadHash", "status") VALUES (?, ?, ?, ?, ?)',
          )
          .run(sessionId, requestId, chatId, payloadHash, 'pending');
      } else
        await this.requests.insert({
          ...request,
          status: 'pending',
          messageId: null,
          timestamp: null,
          error: null,
        });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const saved = sqlite
        ? (sqlite
            .prepare(
              'SELECT "chatId", "payloadHash", "status", "messageId", "timestamp", "error" FROM "outbound_text_requests" WHERE "sessionId" = ? AND "requestId" = ?',
            )
            .get(sessionId, requestId) as StoredReservation | undefined)
        : await this.requests.findOneByOrFail({ sessionId, requestId });
      if (!saved) throw new ServiceUnavailableException('The original send reservation could not be read.');
      if (saved.payloadHash !== payloadHash || saved.chatId !== chatId)
        throw new ConflictException('requestId is already bound to a different message payload.');
      return savedOutcome(saved);
    }
    return null;
  }

  private async markAmbiguous(identity: RequestIdentity, error: unknown): Promise<IdempotentTextResultDto> {
    // The engine may already have accepted the message. Even a persistence failure never grants replay.
    const detail = error instanceof Error ? error.message.slice(0, 1000) : 'The send outcome is unknown.';
    this.logger.warn('Idempotent text send requires reconciliation', { ...identity, error: detail });
    try {
      await this.persistOutcome(identity, { status: 'ambiguous', messageId: null, timestamp: null, error: detail });
    } catch (persistError) {
      // The original PENDING reservation remains durable and still forbids another engine call.
      this.logger.error(
        'Could not persist the ambiguous send outcome',
        persistError instanceof Error ? persistError.message : String(persistError),
        identity,
      );
    }
    return { status: 'ambiguous', error: detail };
  }

  /** SQLite has one native connection: a statement is durable only outside an ambient transaction. */
  private autocommitSqlite(): SynchronousSqliteDatabase | null {
    const connection = this.requests.manager.connection;
    if (connection.options.type !== 'better-sqlite3') return null;
    const sqlite = (connection.driver as unknown as { databaseConnection: SynchronousSqliteDatabase })
      .databaseConnection;
    if (sqlite.inTransaction)
      throw new ServiceUnavailableException(
        'The send journal is busy with another transaction. Retry the same request identity.',
      );
    return sqlite;
  }

  private async persistOutcome(identity: RequestIdentity, outcome: StoredOutcome): Promise<number> {
    // The engine awaited above may have allowed a new unrelated transaction to open. Re-check now,
    // then write synchronously so SENT is never reported from a transaction somebody else can roll back.
    const sqlite = this.autocommitSqlite();
    if (sqlite)
      return sqlite
        .prepare(
          'UPDATE "outbound_text_requests" SET "status" = ?, "messageId" = ?, "timestamp" = ?, "error" = ? WHERE "sessionId" = ? AND "requestId" = ? AND "status" = ?',
        )
        .run(
          outcome.status,
          outcome.messageId,
          outcome.timestamp,
          outcome.error,
          identity.sessionId,
          identity.requestId,
          'pending',
        ).changes;
    const saved = await this.requests.update({ ...identity, status: 'pending' }, outcome);
    return saved.affected ?? 0;
  }
}
