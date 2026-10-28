import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ChatScopeService } from '../auth/chat-scope.service';
import { ChatScoped, CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKeyRole, type ApiKey } from '../auth/entities/api-key.entity';
import {
  IdempotentTextMessageDto,
  IdempotentTextProtocolDto,
  IdempotentTextResultDto,
} from './dto/idempotent-text.dto';
import { IdempotentTextService } from './idempotent-text.service';

@ApiTags('messages')
@Controller('sessions/:sessionId/messages')
export class IdempotentTextController {
  constructor(
    private readonly sends: IdempotentTextService,
    private readonly chatScope: ChatScopeService,
  ) {}

  @ChatScoped('fenced')
  @Get('send-text-idempotent')
  @ApiOperation({ summary: 'Check the durable idempotent text-send protocol without sending a message' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiQuery({ name: 'chatId', required: true, type: String })
  @ApiQuery({
    name: 'messageId',
    required: false,
    type: String,
    description: 'Read a confirmed request receipt for this provider message ID within the selected session and chat.',
  })
  @ApiResponse({ status: 200, type: IdempotentTextProtocolDto })
  async protocol(
    @Param('sessionId') sessionId: string,
    @Query('chatId') chatId?: string,
    @CurrentApiKey() apiKey?: ApiKey,
    @Query('messageId') messageId?: string,
  ): Promise<IdempotentTextProtocolDto> {
    if (typeof chatId !== 'string' || !chatId.trim()) throw new BadRequestException('chatId is required.');
    this.chatScope.requireChat(apiKey, chatId);
    if (messageId !== undefined) {
      if (typeof messageId !== 'string' || !messageId.trim())
        throw new BadRequestException('messageId must not be blank.');
      return { protocol: 'openwa-idempotent-text-v1', receipt: await this.sends.receipt(sessionId, chatId, messageId) };
    }
    return { protocol: 'openwa-idempotent-text-v1' };
  }

  @ChatScoped('fenced')
  @RequireRole(ApiKeyRole.OPERATOR)
  @Post('send-text-idempotent')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send text once, or read the saved outcome for the same requestId and payload' })
  @ApiParam({ name: 'sessionId', description: 'Session ID' })
  @ApiBody({
    type: IdempotentTextMessageDto,
    examples: {
      minimal: {
        value: {
          requestId: 'caller-stable-send-identity',
          chatId: '628123456789@c.us',
          text: 'Hello from OpenWA!',
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: IdempotentTextResultDto })
  @ApiResponse({ status: 409, description: 'The requestId was previously used with a different payload.' })
  send(@Param('sessionId') sessionId: string, @Body() dto: IdempotentTextMessageDto): Promise<IdempotentTextResultDto> {
    return this.sends.send(sessionId, dto);
  }
}
