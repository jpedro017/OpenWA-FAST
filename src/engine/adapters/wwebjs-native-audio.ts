import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { MessageMedia, type Message } from 'whatsapp-web.js';
import { withSafeFetch } from '../../common/security/ssrf-guard';
import { urlFetchProxy } from '../../common/security/proxy-dispatcher';
import { coerceDeclaredSize, inboundMediaMaxBytes, inboundMediaTimeoutMs } from './inbound-media-cap';

type AudioSource = {
  url: string;
  key: Buffer;
  hash: Buffer;
  encryptedHash?: Buffer;
  mimetype: string;
  size: number;
};

function decodeKeyOrHash(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length > 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new BadRequestException('Audio media key or hash is unavailable');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new BadRequestException('Audio media key or hash is invalid');
  }
  return decoded;
}

function audioSource(message: Message, maxBytes: number): AudioSource {
  const raw = message.rawData as Record<string, unknown>;
  if (
    !['audio', 'ptt'].includes(message.type) ||
    !raw ||
    typeof raw.directPath !== 'string' ||
    !raw.directPath.startsWith('/') ||
    raw.directPath.length > 8192 ||
    typeof raw.mimetype !== 'string' ||
    !raw.mimetype.toLowerCase().startsWith('audio/')
  ) {
    throw new BadRequestException('Audio media source is unavailable');
  }
  // Ignore any sender-provided URL: directPath is resolved against this one CDN.
  const url = new URL(`https://mmg.whatsapp.net${raw.directPath}`);
  if (url.origin !== 'https://mmg.whatsapp.net' || url.username || url.password || url.hash) {
    throw new BadRequestException('Audio media source is invalid');
  }
  const size = coerceDeclaredSize(raw.size);
  if (size > maxBytes) throw new PayloadTooLargeException('Audio media exceeds the download limit');
  return {
    url: url.href,
    key: decodeKeyOrHash(raw.mediaKey),
    hash: decodeKeyOrHash(raw.filehash),
    ...(raw.encFilehash ? { encryptedHash: decodeKeyOrHash(raw.encFilehash) } : {}),
    mimetype: raw.mimetype,
    size,
  };
}

async function encryptedAudio(
  source: AudioSource,
  maxBytes: number,
  signal: AbortSignal,
  proxyUrl?: string,
): Promise<Buffer> {
  return withSafeFetch(
    source.url,
    {
      signal,
      headers: { Origin: 'https://web.whatsapp.com', 'Accept-Encoding': 'identity' },
    },
    async response => {
      if (response.status !== 200 || (response.headers.get('content-encoding') ?? 'identity') !== 'identity') {
        throw new BadRequestException('Audio media download is unavailable');
      }
      const declared = response.headers.get('content-length');
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
        throw new PayloadTooLargeException('Encrypted audio exceeds the download limit');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new BadRequestException('Audio media response is empty');
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = (await reader.read()) as { done: boolean; value: Uint8Array };
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new PayloadTooLargeException('Encrypted audio exceeds the download limit');
        }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    },
    { proxyUrl: urlFetchProxy(proxyUrl) },
  ).catch((cause: unknown) => {
    if (cause instanceof PayloadTooLargeException) throw cause;
    if (signal.aborted) throw signal.reason;
    // The shared guard may name a signed CDN URL in its error. Keep that cause
    // internal, while the media limiter's normal warning only sees this text.
    throw new BadRequestException('Audio media download is unavailable', { cause });
  });
}

/**
 * Explicit manual audio read. Uses the installed Baileys crypto primitives, never
 * its unbounded HTTP helper, and authenticates MAC plus plaintext hash before use.
 * It neither calls Message.downloadMedia nor changes the browser's mediaStage.
 */
export async function recoverWwebjsAudioMedia(
  message: Message,
  sessionProxyUrl: string | undefined,
  parentSignal?: AbortSignal,
): Promise<MessageMedia> {
  const maxBytes = inboundMediaMaxBytes();
  const source = audioSource(message, maxBytes);
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.min(inboundMediaTimeoutMs(), 20_000)),
    ...(parentSignal ? [parentSignal] : []),
  ]);
  signal.throwIfAborted();
  const { getMediaKeys, aesDecryptWithIV } = await import('@whiskeysockets/baileys');
  signal.throwIfAborted();
  // AES-CBC padding adds at most16 bytes; WhatsApp appends a10-byte MAC.
  const encrypted = await encryptedAudio(source, maxBytes + 26, signal, sessionProxyUrl);
  if (encrypted.length < 26 || (encrypted.length - 10) % 16 !== 0)
    throw new BadRequestException('Audio media authentication failed');
  if (source.encryptedHash && !timingSafeEqual(createHash('sha256').update(encrypted).digest(), source.encryptedHash)) {
    throw new BadRequestException('Audio media authentication failed');
  }
  const keys = await getMediaKeys(source.key, 'audio');
  if (!keys.macKey || keys.macKey.length !== 32) throw new BadRequestException('Audio media authentication failed');
  const ciphertext = encrypted.subarray(0, -10);
  const mac = createHmac('sha256', keys.macKey).update(keys.iv).update(ciphertext).digest().subarray(0, 10);
  if (!timingSafeEqual(mac, encrypted.subarray(-10)))
    throw new BadRequestException('Audio media authentication failed');
  let bytes: Buffer;
  try {
    bytes = aesDecryptWithIV(ciphertext, keys.cipherKey, keys.iv);
  } catch (cause) {
    throw new BadRequestException('Audio media decryption failed', { cause });
  }
  if (bytes.length > maxBytes) throw new PayloadTooLargeException('Audio media exceeds the download limit');
  if (
    !bytes.length ||
    (source.size > 0 && source.size !== bytes.length) ||
    !timingSafeEqual(createHash('sha256').update(bytes).digest(), source.hash)
  ) {
    throw new BadRequestException('Audio media authentication failed');
  }
  signal.throwIfAborted();
  return new MessageMedia(source.mimetype, bytes.toString('base64'), undefined, bytes.length);
}
