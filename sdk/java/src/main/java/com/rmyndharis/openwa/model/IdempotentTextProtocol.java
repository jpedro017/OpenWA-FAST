package com.rmyndharis.openwa.model;

/** Protocol is openwa-idempotent-text-v1 when durable text-send recovery is supported. */
public record IdempotentTextProtocol(String protocol, IdempotentTextReceipt receipt) {}
