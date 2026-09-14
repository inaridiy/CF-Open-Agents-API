/** Private bridge executed inside the assigned Sandbox; it never receives model credentials. */
export const environmentMcpScript = String.raw`
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const definitions = JSON.parse(await readFile(process.argv[2], 'utf8'));
const sessions = new Map();
function open(label, config) {
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { child, id: randomUUID(), pending: new Map(), closed: false };
  sessions.set(label, state);
  const fail = () => {
    state.closed = true;
    for (const pending of state.pending.values()) pending.reject(new Error('MCP process closed'));
    state.pending.clear();
    child.kill('SIGKILL');
  };
  child.on('error', fail);
  child.on('exit', fail);
  child.stderr.resume();
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return fail();
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && !message.method) {
          const pending = state.pending.get(message.id);
          if (pending) { state.pending.delete(message.id); pending.resolve(message); }
        } else if (message.id !== undefined) {
          child.stdin.write(JSON.stringify({jsonrpc:'2.0', id:message.id, ...(message.method === 'ping' ? {result:{}} : {error:{code:-32601,message:'Server requests are unavailable'}})}) + '\n');
        }
      } catch { fail(); }
    }
  });
  return state;
}
const server = createServer(async (request, response) => {
  try {
    const label = new URL(request.url, 'http://sandbox').pathname.slice(1);
    const config = definitions[label];
    if (!config) { response.writeHead(404).end(); return; }
    let size = 0; const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) { response.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (config.type === 'http') {
      const headers = new Headers(config.headers ?? {});
      for (const key of ['accept','content-type','mcp-session-id','mcp-protocol-version','last-event-id'])
        if (request.headers[key]) headers.set(key, request.headers[key]);
      if (config.authorization) headers.set('authorization', config.authorization);
      const abort = new AbortController();
      response.on('close', () => abort.abort());
      const upstream = await fetch(config.server_url, {
        method: request.method, headers, body: request.method === 'POST' ? body : undefined,
        redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120000)]),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (upstream.body) for await (const chunk of upstream.body) response.write(chunk);
      response.end(); return;
    }
    if (request.method === 'GET') { response.writeHead(405).end(); return; }
    let state = sessions.get(label);
    if (request.method === 'DELETE') {
      if (state && request.headers['mcp-session-id'] === state.id) state.child.kill('SIGTERM');
      response.writeHead(204).end(); return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const message = JSON.parse(body.toString());
    if (message.method === 'initialize') {
      if (state) { response.writeHead(409).end('MCP session already initialized'); return; }
      state = open(label, config);
    } else if (!state || request.headers['mcp-session-id'] !== state.id) {
      response.writeHead(404).end('MCP session unavailable'); return;
    }
    if (state.closed) { response.writeHead(409).end('MCP process exited; request was not replayed'); return; }
    if (message.id === undefined) {
      state.child.stdin.write(JSON.stringify(message) + '\n'); response.writeHead(202).end(); return;
    }
    if (state.pending.size >= 64 || state.pending.has(message.id)) { response.writeHead(409).end(); return; }
    let timer;
    const result = new Promise((resolve, reject) => {
      state.pending.set(message.id, {resolve, reject});
      timer = setTimeout(() => reject(new Error('MCP request timeout')), 120000);
    });
    response.on('close', () => {
      if (state.pending.delete(message.id)) state.child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:message.id}}) + '\n');
    });
    state.child.stdin.write(JSON.stringify(message) + '\n');
    try {
      const value = await result;
      response.writeHead(200, {'content-type':'application/json','mcp-session-id':state.id}).end(JSON.stringify(value));
    } finally { clearTimeout(timer); state.pending.delete(message.id); }
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end('Environment MCP request failed');
  }
});
server.listen(4501, '0.0.0.0');
`;
