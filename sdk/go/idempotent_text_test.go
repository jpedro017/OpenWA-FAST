package openwa

import (
    "context"
    "strings"
    "testing"
)

func TestIdempotentTextAndReadonlyReceipt(t *testing.T) {
    rt := &recordTransport{status: 200, body: `{"status":"sent","messageId":"wa1","timestamp":1}`}
    c := newTestClient(t, rt)
    result, err := c.Messages.SendTextIdempotent(context.Background(), "s1", IdempotentTextRequest{
        SendTextRequest: SendTextRequest{ChatID: "a@c.us", Text: "hi"}, RequestID: "turn1",
    })
    if err != nil || result.MessageID != "wa1" { t.Fatalf("receipt: %+v, %v", result, err) }
    if !strings.Contains(string(rt.lastRaw), `"requestId":"turn1"`) { t.Fatalf("body: %s", rt.lastRaw) }
    if rt.lastReq.URL.Path != "/api/sessions/s1/messages/send-text-idempotent" { t.Fatal(rt.lastReq.URL.Path) }
    rt.body = `{"protocol":"openwa-idempotent-text-v1","receipt":{"requestId":"turn1","messageId":"wa1","timestamp":1}}`
    protocol, err := c.Messages.TextIdempotency(context.Background(), "s1", "a@c.us", "wa1")
    if err != nil || protocol.Receipt == nil || protocol.Receipt.RequestID != "turn1" { t.Fatalf("protocol: %+v, %v", protocol, err) }
    if rt.lastReq.Method != "GET" || rt.lastReq.URL.Query().Get("messageId") != "wa1" { t.Fatal(rt.lastReq.URL) }
}
