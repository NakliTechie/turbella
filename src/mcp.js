// Minimal self-contained MCP (Model Context Protocol) server over stdio.
// JSON-RPC 2.0, one request/response per line. No npm dependency — the MCP
// spec's core surface (initialize, tools, resources, ping) is small enough to
// implement directly.
//
// Exposes:
//   tool  turbellla_status  — current session status: events, byKind, gauge, sockPath
//
// The daemon's address (port + sock path) comes from the daemon's state file,
// which `turbella start` writes on startup. If the daemon isn't running, the
// MCP server still initializes but status calls return an isError response.
//
// Localhost / stdio only — no network, no secrets (AGENTS.md privacy rule).

import { readState } from './daemon.js';


const SERVER_INFO = { name: 'turbella', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

const CAPABILITIES = { resources: {}, tools: {} };

const TOOLS = [
  {
    name: 'turbella_status',
    description:
      'Current Turbella daemon status: number of events, counts by kind, turbulence gauge (0..1), and daemon socket path.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const RESOURCES = [
  {
    uri: 'turbella://status',
    name: 'Turbella Status',
    description: 'Live daemon status: events, byKind, gauge, sockPath.',
    mimeType: 'application/json',
  },
];

async function fetchStatus() {
  const st = readState();
  if (!st || !st.port) {
    return { ok: false, error: 'turbella daemon not running (no state file)' };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${st.port}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { ok: false, error: `daemon /status returned ${res.status}` };
    }
    return { ok: true, value: await res.json() };
  } catch (e) {
    return { ok: false, error: `cannot reach daemon at ${st.port}: ${e.message}` };
  }
}

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}
function jsonRpcError(id, code, message, data) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}
// ---- stdio loop -----------------------------------------------------------

let stdinBuf = '';

export async function runMcp() {
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setEncoding('utf8');

  for await (const chunk of stdin) {
    stdinBuf += chunk;
    let idx;
    while ((idx = stdinBuf.indexOf('\n')) >= 0) {
      const line = stdinBuf.slice(0, idx).trim();
      stdinBuf = stdinBuf.slice(idx + 1);
      if (!line) continue;
      await handleLine(stdout, line);
    }
  }
}

async function handleLine(stdout, line) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = req;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case 'initialize': {
        const result = {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        };
        if (!isNotification) stdout.write(jsonRpc(id, result) + '\n');
        break;
      }
      case 'initialized':
        break;
      case 'ping': {
        if (!isNotification) stdout.write(jsonRpc(id, {}) + '\n');
        break;
      }
      case 'tools/list': {
        const result = { tools: TOOLS };
        if (!isNotification) stdout.write(jsonRpc(id, result) + '\n');
        break;
      }
      case 'tools/call': {
        const { name, arguments: args } = params || {};
        const result = await handleToolCall(name, args);
        if (!isNotification)
          stdout.write(
            jsonRpc(id, { content: result.content, isError: result.isError }) + '\n',
          );
        break;
      }
      case 'resources/list': {
        const result = { resources: RESOURCES };
        if (!isNotification) stdout.write(jsonRpc(id, result) + '\n');
        break;
      }
      case 'resources/read': {
        const { uri } = params || {};
        const result = await handleResourceRead(uri);
        if (!isNotification) stdout.write(jsonRpc(id, result) + '\n');
        break;
      }
      default: {
        if (!isNotification)
          stdout.write(jsonRpcError(id, -32601, `Method not found: ${method}`) + '\n');
      }
    }
  } catch (err) {
    if (!isNotification)
      stdout.write(
        jsonRpcError(id, -32603, 'Internal error', String(err.message)) + '\n',
      );
  }
}

async function handleToolCall(name, args) {
  if (name === 'turbella_status') {
    const status = await fetchStatus();
    if (!status.ok)
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        isError: true,
      };
    return {
      content: [{ type: 'text', text: JSON.stringify(status.value, null, 2) }],
    };
  }
  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

async function handleResourceRead(uri) {
  if (uri === 'turbella://status') {
    const status = await fetchStatus();
    if (!status.ok)
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(status, null, 2),
          },
        ],
        isError: true,
      };
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(status.value, null, 2),
        },
      ],
    };
  }
  return {
    contents: [{ uri, mimeType: 'application/json', text: `Unknown resource: ${uri}` }],
    isError: true,
  };
}

