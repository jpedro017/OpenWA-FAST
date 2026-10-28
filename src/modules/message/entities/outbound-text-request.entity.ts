import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { bigintToNumberTransformer } from './message.entity';

/** Durable send identity, deliberately independent of message retention and echo-row merging. */
@Entity('outbound_text_requests')
@Index('IDX_outbound_text_requests_session_chat_message', ['sessionId', 'chatId', 'messageId'])
export class OutboundTextRequest {
  @PrimaryColumn({ type: 'varchar' })
  sessionId!: string;

  @PrimaryColumn({ type: 'varchar', length: 200 })
  requestId!: string;

  @Column()
  chatId!: string;

  @Column()
  payloadHash!: string;

  @Column({ type: 'varchar', default: 'pending' })
  status!: 'pending' | 'sent' | 'ambiguous' | 'refused';

  @Column({ type: 'varchar', nullable: true })
  messageId!: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumberTransformer })
  timestamp!: number | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
