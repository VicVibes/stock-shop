const assert = require('assert');
const http = require('http');
const { runAssistant } = require('../src/assistant');

(async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      assert.strictEqual(req.url, '/v1/chat/completions');
      assert.strictEqual(req.headers['content-type'], 'application/json');
      const payload = JSON.parse(body);
      assert.strictEqual(payload.model, 'local-stock-model');
      assert.ok(payload.messages.length);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Local AI connected.' } }],
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.LOCAL_AI_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LOCAL_AI_MODEL = 'local-stock-model';
  try {
    const result = await runAssistant('Hello', [], 'test');
    assert.strictEqual(result.reply, 'Local AI connected.');
    console.log('Local AI integration test passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
