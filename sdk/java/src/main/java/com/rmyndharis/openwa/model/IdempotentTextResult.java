package com.rmyndharis.openwa.model;

/** Only status=sent carries a confirmed messageId and timestamp. */
public record IdempotentTextResult(String status, String messageId, Long timestamp, String error) {}
