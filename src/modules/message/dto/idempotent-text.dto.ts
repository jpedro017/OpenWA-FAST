import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { SendTextMessageDto } from './send-message.dto';

export class IdempotentTextMessageDto extends SendTextMessageDto {
  @ApiProperty({
    description: 'Persistent caller-generated send identity. Never reuse it for another payload.',
    maxLength: 200,
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/\S/, { message: 'requestId must not be blank' })
  @MaxLength(200)
  requestId!: string;
}

export class IdempotentTextReceiptDto {
  @ApiProperty()
  requestId!: string;

  @ApiProperty()
  messageId!: string;

  @ApiProperty({ description: 'Confirmed provider timestamp in epoch seconds.' })
  timestamp!: number;
}

export class IdempotentTextProtocolDto {
  @ApiProperty({ enum: ['openwa-idempotent-text-v1'] })
  protocol!: 'openwa-idempotent-text-v1';

  @ApiPropertyOptional({
    type: IdempotentTextReceiptDto,
    nullable: true,
    description:
      'Present only when looking up messageId, and null when no confirmed request matches this session and chat.',
  })
  receipt?: IdempotentTextReceiptDto | null;
}

export class IdempotentTextResultDto {
  @ApiProperty({ enum: ['sent', 'pending', 'ambiguous', 'refused'] })
  status!: 'sent' | 'pending' | 'ambiguous' | 'refused';

  @ApiPropertyOptional({ description: 'Confirmed provider message identity; present only for sent.' })
  messageId?: string;

  @ApiPropertyOptional({ description: 'Provider timestamp in epoch seconds; present only for sent.' })
  timestamp?: number;

  @ApiPropertyOptional({
    description: 'Why the send cannot currently be confirmed. No automatic engine replay occurs.',
  })
  error?: string;
}
