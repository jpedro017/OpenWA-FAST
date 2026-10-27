import { createCipheriv, createHash, createHmac } from 'node:crypto';
import type { Message } from 'whatsapp-web.js';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { withSafeFetch } from '../../common/security/ssrf-guard';
import { recoverWwebjsAudioMedia } from './wwebjs-native-audio';

jest.mock('../../common/security/ssrf-guard', () => ({ withSafeFetch: jest.fn() }));
jest.mock('@whiskeysockets/baileys', () => {
  const crypto = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    getMediaKeys: jest.fn(() =>
      Promise.resolve({ iv: Buffer.alloc(16, 1), cipherKey: Buffer.alloc(32, 2), macKey: Buffer.alloc(32, 3) }),
    ),
    aesDecryptWithIV: (data: Buffer, key: Buffer, iv: Buffer) => {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    },
  };
});

function fixture() {
  const bytes = Buffer.from('OggS synthetic audio');
  const cipher = createCipheriv('aes-256-cbc', Buffer.alloc(32, 2), Buffer.alloc(16, 1));
  const encryptedBody = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const mac = createHmac('sha256', Buffer.alloc(32, 3))
    .update(Buffer.alloc(16, 1))
    .update(encryptedBody)
    .digest()
    .subarray(0, 10);
  const encrypted = Buffer.concat([encryptedBody, mac]);
  const raw = {
    directPath: '/v/test/audio.enc?auth=synthetic',
    mediaKey: Buffer.alloc(32, 4).toString('base64'),
    filehash: createHash('sha256').update(bytes).digest('base64'),
    encFilehash: createHash('sha256').update(encrypted).digest('base64'),
    mimetype: 'audio/ogg; codecs=opus',
    size: bytes.length,
    mediaData: { mediaStage: 'DECRYPTING' },
  };
  const message = { type: 'ptt', rawData: raw, downloadMedia: jest.fn() } as unknown as Message;
  const safeFetch = withSafeFetch as jest.Mock;
  safeFetch.mockImplementation(
    async (_url: string, _init: RequestInit, use: (response: Response) => Promise<unknown>) =>
      use(new Response(encrypted, { status: 200, headers: { 'content-length': String(encrypted.length) } })),
  );
  return {
    bytes,
    encrypted,
    raw,
    message,
    safeFetch,
    run: (signal?: AbortSignal) => recoverWwebjsAudioMedia(message, undefined, signal),
  };
}

describe('manual native audio recovery', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => {
    delete process.env.MEDIA_DOWNLOAD_MAX_BYTES;
    delete process.env.MEDIA_DOWNLOAD_TIMEOUT_MS;
  });

  it('authenticates and decrypts the targeted audio without changing the stuck browser stage', async () => {
    const h = fixture();
    const result = await h.run();
    expect(Buffer.from(result.data, 'base64')).toEqual(h.bytes);
    expect(h.safeFetch).toHaveBeenCalledTimes(1);
    const call = (h.safeFetch.mock.calls as unknown[][])[0];
    expect(call[0]).toBe('https://mmg.whatsapp.net/v/test/audio.enc?auth=synthetic');
    expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    expect(h.message.downloadMedia).not.toHaveBeenCalled();
    expect(h.raw.mediaData.mediaStage).toBe('DECRYPTING');
  });

  it.each(['key', 'hash', 'source', 'type', 'declared-size'])(
    'rejects invalid %s before any network request',
    async kind => {
      const h = fixture();
      if (kind === 'key') h.raw.mediaKey = 'invalid';
      if (kind === 'hash') h.raw.filehash = 'invalid';
      if (kind === 'source') h.raw.directPath = 'https://internal.example/media';
      if (kind === 'type') Object.assign(h.message, { type: 'document' });
      if (kind === 'declared-size') process.env.MEDIA_DOWNLOAD_MAX_BYTES = '1';
      await expect(h.run()).rejects.toBeDefined();
      expect(h.safeFetch).not.toHaveBeenCalled();
    },
  );

  it.each(['MAC', 'plaintext-hash', 'encrypted-hash'])('refuses a mismatched %s', async kind => {
    const h = fixture();
    if (kind === 'MAC') {
      h.encrypted[h.encrypted.length - 1] ^= 1;
      h.raw.encFilehash = createHash('sha256').update(h.encrypted).digest('base64');
    }
    if (kind === 'plaintext-hash') h.raw.filehash = Buffer.alloc(32, 5).toString('base64');
    if (kind === 'encrypted-hash') h.raw.encFilehash = Buffer.alloc(32, 5).toString('base64');
    await expect(h.run()).rejects.toThrow('Audio media authentication failed');
  });

  it('bounds bytes while streaming even without a trustworthy Content-Length', async () => {
    const h = fixture();
    process.env.MEDIA_DOWNLOAD_MAX_BYTES = '24';
    h.safeFetch.mockImplementation(
      async (_url: string, _init: RequestInit, use: (response: Response) => Promise<unknown>) =>
        use(new Response(Buffer.alloc(51), { status: 200 })),
    );
    await expect(h.run()).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('keeps the session egress proxy and the guarded fetch instead of substituting global fetch', async () => {
    const h = fixture();
    const originalFetch = globalThis.fetch;
    await recoverWwebjsAudioMedia(h.message, 'http://proxy.example:8080');
    expect((h.safeFetch.mock.calls as unknown[][])[0][3]).toEqual({ proxyUrl: 'http://proxy.example:8080' });
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it('aborts before network work when the client disconnected', async () => {
    const h = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(h.run(abort.signal)).rejects.toBeDefined();
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it('keeps signed CDN URLs out of the public error while preserving its original cause', async () => {
    const h = fixture();
    const cause = new Error('guard refused https://mmg.whatsapp.net/v/private?auth=synthetic-secret');
    h.safeFetch.mockRejectedValue(cause);
    await expect(h.run()).rejects.toMatchObject({ message: 'Audio media download is unavailable', cause });
  });

  it('enforces the existing timeout when it is shorter than the manual20s ceiling', async () => {
    const h = fixture();
    process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '5';
    h.safeFetch.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) reject(signal.reason as Error);
          else signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
        }),
    );
    await expect(h.run()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it.each([302, 404, 500])('refuses HTTP%s instead of interpreting it as audio bytes', async status => {
    const h = fixture();
    h.safeFetch.mockImplementation(
      async (_url: string, _init: RequestInit, use: (response: Response) => Promise<unknown>) =>
        use(new Response('unavailable', { status })),
    );
    await expect(h.run()).rejects.toBeInstanceOf(BadRequestException);
  });
});
