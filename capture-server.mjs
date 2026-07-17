import { createServer } from "http";
import { writeFileSync, appendFileSync } from "fs";

const PORT = Number(process.env.PORT) || 8877;
const LOG = "./capture.log";
writeFileSync(LOG, "");

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  let bodyPreview = body;
  try {
    const parsed = JSON.parse(body);
    // Truncate big fields but keep structure.
    bodyPreview = JSON.stringify(parsed).slice(0, 4000);
  } catch {}
  const entry = {
    time: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: req.headers,
    bodyPreview,
  };
  appendFileSync(LOG, JSON.stringify(entry, null, 2) + "\n----\n");
  console.error(`[capture] ${req.method} ${req.url}`);

  // Return a minimal valid Anthropic SSE response so claude completes cleanly.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  const msgId = "msg_capture";
  res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: "claude-opus-4-8", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n\n`);
  res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
  res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "captured" } })}\n\n`);
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
  res.write(`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.error(`[capture] listening on http://127.0.0.1:${PORT}`);
});
