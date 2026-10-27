import type { Client } from 'whatsapp-web.js';
import { WwebjsMessaging } from './wwebjs-messaging';
import type { WwebjsEngineHost } from './wwebjs-host';
import { createLogger } from '../../common/services/logger.service';
import { MessageNotFoundError } from '../../common/errors/message-not-found.error';
import { EngineTransportError } from '../../common/errors/engine-transport.error';
import { recoverWwebjsAudioMedia } from './wwebjs-native-audio';

jest.mock('./wwebjs-native-audio', () => ({
  recoverWwebjsAudioMedia: jest.fn().mockResolvedValue({ mimetype: 'audio/ogg', data: 'YXVkaW8=' }),
}));

const ID = 'false_111@lid_NATIVE';

function fixture() {
  const message = { id: { _serialized: ID, remote: '111@lid' }, hasMedia: true, type: 'ptt' };
  const client = {
    getMessageById: jest.fn().mockResolvedValue(message),
    getChatById: jest.fn(),
    sendSeen: jest.fn(),
  };
  const media = { mimetype: 'audio/ogg', data: Buffer.from('synthetic audio').toString('base64') };
  const capInboundMediaFor = jest.fn().mockResolvedValue(media);
  const reportIfPageTransportError = jest.fn();
  const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
  const host = {
    ensureReady: jest.fn(),
    getClient: () => client as unknown as Client,
    capInboundMediaFor,
    reportIfPageTransportError,
    isPageTransportError: (error: unknown) => error === transportError,
    logger: createLogger('media-recovery-test'),
    config: {},
  } as unknown as WwebjsEngineHost;
  return {
    subject: new WwebjsMessaging(host),
    client,
    message,
    media,
    capInboundMediaFor,
    reportIfPageTransportError,
    transportError,
  };
}

describe('targeted manual media recovery', () => {
  beforeEach(() => jest.clearAllMocks());
  it('looks up only the native id and downloads only after fencing its real chat', async () => {
    const h = fixture();
    await expect(h.subject.getMessageMedia(['628111@c.us', '111@lid'], ID)).resolves.toEqual(h.media);
    expect(h.client.getMessageById).toHaveBeenCalledTimes(1);
    expect(h.client.getMessageById).toHaveBeenCalledWith(ID);
    expect(h.capInboundMediaFor).toHaveBeenCalledWith(h.message, undefined, expect.any(Function));
    expect(h.client.getChatById).not.toHaveBeenCalled();
    expect(h.client.sendSeen).not.toHaveBeenCalled();
  });

  it('refuses a message from another chat before downloading any bytes', async () => {
    const h = fixture();
    h.message.id.remote = 'foreign@lid';
    await expect(h.subject.getMessageMedia(['111@lid'], ID)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(h.capInboundMediaFor).not.toHaveBeenCalled();
  });

  it('uses native audio recovery inside the existing bounded download callback', async () => {
    const h = fixture();
    h.capInboundMediaFor.mockImplementation((_message: unknown, _limit: unknown, download: () => Promise<unknown>) =>
      download(),
    );
    await h.subject.getMessageMedia(['111@lid'], ID);
    expect(recoverWwebjsAudioMedia).toHaveBeenCalledWith(h.message, undefined, undefined);
    h.message.type = 'image';
    h.capInboundMediaFor.mockResolvedValue(h.media);
    await h.subject.getMessageMedia(['111@lid'], ID);
    expect(h.capInboundMediaFor).toHaveBeenLastCalledWith(h.message);
    expect(recoverWwebjsAudioMedia).toHaveBeenCalledTimes(1);
  });

  it('does not infer a lid to be the phone with the same digits', async () => {
    const h = fixture();
    await expect(h.subject.getMessageMedia(['111@c.us'], ID)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(h.capInboundMediaFor).not.toHaveBeenCalled();
  });

  it('accepts the equivalent user dialect and rejects a mismatched message id', async () => {
    const h = fixture();
    h.message.id.remote = '628111@s.whatsapp.net';
    await expect(h.subject.getMessageMedia(['628111@c.us'], ID)).resolves.toEqual(h.media);
    h.message.id._serialized = 'another-message';
    await expect(h.subject.getMessageMedia(['628111@c.us'], ID)).rejects.toBeInstanceOf(MessageNotFoundError);
    expect(h.capInboundMediaFor).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'no-media', 'revoked'])('serves no recovered bytes when %s', async state => {
    const h = fixture();
    if (state === 'missing') h.client.getMessageById.mockResolvedValue(null);
    else if (state === 'no-media') h.message.hasMedia = false;
    else h.message.type = 'revoked';
    if (state === 'missing') {
      await expect(h.subject.getMessageMedia(['111@lid'], ID)).rejects.toBeInstanceOf(MessageNotFoundError);
    } else {
      await expect(h.subject.getMessageMedia(['111@lid'], ID)).resolves.toBeUndefined();
    }
    expect(h.capInboundMediaFor).not.toHaveBeenCalled();
  });

  it('preserves omission from the bounded download path instead of claiming bytes', async () => {
    const h = fixture();
    h.capInboundMediaFor.mockResolvedValue({ mimetype: 'audio/ogg', omitted: true });
    await expect(h.subject.getMessageMedia(['111@lid'], ID)).resolves.toEqual({ mimetype: 'audio/ogg', omitted: true });
  });

  it('checks cancellation before lookup and after the non-abortable download settles', async () => {
    const h = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(h.subject.getMessageMedia(['111@lid'], ID, abort.signal)).rejects.toBeDefined();
    expect(h.client.getMessageById).not.toHaveBeenCalled();
    const during = new AbortController();
    h.capInboundMediaFor.mockImplementation(() => {
      during.abort();
      return Promise.resolve(h.media);
    });
    await expect(h.subject.getMessageMedia(['111@lid'], ID, during.signal)).rejects.toBeDefined();
  });

  it('classifies a dead page while preserving ordinary lookup errors', async () => {
    const h = fixture();
    h.client.getMessageById.mockRejectedValue(h.transportError);
    await expect(h.subject.getMessageMedia(['111@lid'], ID)).rejects.toBeInstanceOf(EngineTransportError);
    expect(h.reportIfPageTransportError).toHaveBeenCalledWith(h.transportError, 'getMessageMedia');
    const ordinary = new Error('synthetic lookup unavailable');
    h.client.getMessageById.mockRejectedValue(ordinary);
    await expect(h.subject.getMessageMedia(['111@lid'], ID)).rejects.toBe(ordinary);
  });
});
