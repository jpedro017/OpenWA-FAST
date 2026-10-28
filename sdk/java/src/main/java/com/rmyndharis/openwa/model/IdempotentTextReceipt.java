package com.rmyndharis.openwa.model;

/** Read-only proof that the selected message was sent under a durable request identity. */
public record IdempotentTextReceipt(String requestId, String messageId, long timestamp) {}
