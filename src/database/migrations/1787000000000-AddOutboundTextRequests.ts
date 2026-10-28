import { MigrationInterface, QueryRunner } from 'typeorm';

/** Requests survive message retention. A pending row is never a licence to repeat an engine call. */
export class AddOutboundTextRequests1787000000000 implements MigrationInterface {
  name = 'AddOutboundTextRequests1787000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('outbound_text_requests'))) {
      const createdAt =
        queryRunner.dataSource.options.type === 'postgres'
          ? 'TIMESTAMP NOT NULL DEFAULT now()'
          : "datetime NOT NULL DEFAULT (datetime('now'))";
      await queryRunner.query(`CREATE TABLE "outbound_text_requests" (
      "sessionId" varchar NOT NULL, "requestId" varchar(200) NOT NULL,
      "chatId" varchar NOT NULL, "payloadHash" varchar NOT NULL,
      "status" varchar NOT NULL DEFAULT ('pending'), "messageId" varchar,
      "timestamp" bigint, "error" text, "createdAt" ${createdAt},
      PRIMARY KEY ("sessionId", "requestId"))`);
    }
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_outbound_text_requests_session_chat_message" ON "outbound_text_requests" ("sessionId", "chatId", "messageId")',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS "outbound_text_requests"');
  }
}
