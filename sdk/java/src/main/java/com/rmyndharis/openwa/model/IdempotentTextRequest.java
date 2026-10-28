package com.rmyndharis.openwa.model;

import java.util.List;

/** Persistent caller identity and the complete text payload. Never change either on retry. */
public record IdempotentTextRequest(
    String requestId, String chatId, String text, List<String> mentions, Boolean linkPreview,
    CustomLinkPreview customLinkPreview, String quotedMessageId) {
    public IdempotentTextRequest(String requestId, SendTextRequest body) {
        this(requestId, body.chatId(), body.text(), body.mentions(), body.linkPreview(),
            body.customLinkPreview(), body.quotedMessageId());
    }
}
