// Minimal self-contained MCP (Model Context Protocol) server over stdio.
// JSON-RPC 2.0, one request/response per line. No npm dependency — the MCP
// spec's core surface (initialize, tools, resources, ping) is small enough to
// implement directly.
//
// Exposes:
//   tools     every daemon tool in manifest.js, as turbella_<name>, run through
//             the same handlers as the CLI (tools.js)
//   resource  turbella://status — the status tool's result
//
// The daemon's address (port + sock path) comes from the daemon's state file,
// which `turbella start` writes on startup. If the daemon isn't running, the
// MCP server still initializes but status calls return an isError response.
//
// Localhost / stdio only — no network, no secrets (AGENTS.md privacy rule).

import { HANDLERS } from './tools.js';
import { toolsFor } from './manifest.js';


const SERVER_INFO = { name: 'turbella', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

const CAPABILITIES = { resources: {}, tools: {} };

const PREFIX = 'turbella_';
// Person-only tools stay off MCP: an agent must not change the person's settings.
const TOOLS = toolsFor('daemon').filter((t) => !t.personOnly).map((t) => ({
  name: PREFIX + t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

const RESOURCES = [
  {
    uri: 'turbella://status',
    name: 'Turbella Status',
    description: 'Live daemon status: events, byKind, gauge, sockPath.',
    mimeType: 'application/json',
  },
];

async function fetchStatus() {
  try { return { ok: true, value: await HANDLERS.status({}) }; }
  catch (e) { return { ok: false, error: `turbella ${e.message}` }; }
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
    stdout.write(jsonRpcError(null, -32700, 'Parse error') + '\n');
    return;
  }
  if (!req || typeof req !== 'object' || Array.isArray(req)) {
    stdout.write(jsonRpcError(null, -32600, 'Invalid Request') + '\n');
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
  const listed = TOOLS.some((t) => t.name === name);
  const tool = listed ? HANDLERS[name.slice(PREFIX.length)] : null;
  if (!tool) {
    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const value = await tool(args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
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

