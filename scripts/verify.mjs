// Turbella checks: transcript reader, gauge, playback, daemon, hook binary,
// tailer, CLI, MCP server and manifest parity.
// Run:  npm run verify      exit 0 when every check passes
//
// Everything runs on this machine against synthetic fixtures (test/fixtures,
// written in Claude Code's real record shape). Sockets and generated files go
// in one temporary folder under /tmp, deleted at the end.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, appendFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { createServer as createRawServer, createConnection } from 'node:net';
import { get as httpGet } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeFile } from '../src/reader.js';
import { KIND } from '../src/event.js';
import { gaugeSnapshot } from '../src/gauge.js';
import { createPlayer } from '../src/playback.js';
import { createSignal, loudness, SAMPLES } from '../src/signal.js';
import { start, stop, readState, AlreadyRunning, __state as daemonState, __clear as daemonClear } from '../src/daemon.js';
import { writeEvent } from '../src/socketWrite.js';
import { MANIFEST, toolsFor } from '../src/manifest.js';
import { HANDLERS } from '../src/tools.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIX = (f) => join(ROOT, 'test', 'fixtures', f);
const BIN = join(ROOT, 'bin', 'turbella');
const HOOK = join(ROOT, 'bin', 'turbella-hook');
const MCP_BIN = join(ROOT, 'bin', 'turbella-mcp');
const TMP = mkdtempSync('/tmp/tbv-'); // short: macOS caps socket paths at 104 characters
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.TURBELLA_OPEN = '0'; // SessionStart must not open browser tabs during checks

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: got ${actual}, expected ${expected}`);
}
const tally = (evs) => evs.reduce((m, e) => ((m[e.kind] = (m[e.kind] || 0) + 1), m), {});

function useSock(name) {
  process.env.TURBELLA_SOCK = join(TMP, name);
  return process.env.TURBELLA_SOCK;
}
function killStateDaemon() {
  const st = readState();
  if (st) { try { process.kill(st.pid); } catch {} }
  return st;
}
const runHook = (payload) => execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });

// Read SSE events until `count` arrive or `ms` pass.
async function readSSE(port, { count = 1, ms = 1500, headers = {} } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, { signal: ctrl.signal, headers });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const out = [];
  let buf = '';
  const deadline = Date.now() + ms;
  while (out.length < count && Date.now() < deadline) {
    const r = await Promise.race([reader.read(), sleep(100).then(() => null)]);
    if (!r) continue;
    if (r.done) break;
    buf += dec.decode(r.value);
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      const d = p.match(/^data: (.*)$/m);
      if (d) out.push({ id: Number(p.match(/^id: (\d+)$/m)?.[1]), ev: JSON.parse(d[1]) });
    }
  }
  ctrl.abort();
  return out;
}

async function main() {
  // ---- transcript reader -------------------------------------------------------
  const retry = await readClaudeFile(FIX('claude-retry-loop.jsonl'));
  const rt = tally(retry);
  check('reader: one think event from top-level thinkingDurationMs', rt[KIND.THINK] || 0, 1);
  check('reader: request-blob records do not count again (2 failures)', rt[KIND.TOOL_FAIL] || 0, 2);
  check('reader: 2 successful calls', rt[KIND.TOOL] || 0, 2);
  const fails = retry.filter((e) => e.kind === KIND.TOOL_FAIL);
  check('reader: array and string error text hash alike', fails[0].sig === fails[1].sig && !!fails[0].sig, true);
  check('reader: sidechain records get the subagent lane', retry.filter((e) => e.agent === 'subagent').length, 1);
  check('reader: edits carry a file-path hash', !!retry.find((e) => e.tool === 'Write').target, true);
  const clean = await readClaudeFile(FIX('claude-clean.jsonl'));
  check('reader: 3 different inputs give 3 different hashes', new Set(clean.map((e) => e.sig)).size, 3);
  check('reader: clean session has no failures', tally(clean)[KIND.TOOL_FAIL] || 0, 0);
  let fifoRefused = false;
  try { await readClaudeFile('/dev/null'); } catch { fifoRefused = true; }
  check('reader: refuses a non-regular file', fifoRefused, true);

  // ---- gauge -----------------------------------------------------------------------
  const gRetry = gaugeSnapshot(retry);
  const gClean = gaugeSnapshot(clean);
  console.log(`gauge retry-loop = ${gRetry.toFixed(3)}, clean = ${gClean.toFixed(3)}`);
  check('gauge: retry loop rises above 0.2', gRetry > 0.2, true);
  check('gauge: clean session stays under 0.2', gClean < 0.2, true);
  const t = 1_000_000;
  const ok = (ts, tool = 'Read', extra = {}) => ({ ts, kind: 'tool', status: 'ok', tool, ...extra });
  const fail = (ts) => ({ ts, kind: 'tool_fail', status: 'error', tool: 'Bash', sig: 'sha256:x' });
  const base = [ok(t), fail(t + 1000), fail(t + 2000)];
  check('gauge: a long silence never drops it to 0', gaugeSnapshot(base, { now: t + 6 * 60_000 }) > 0, true);
  const withStarts = base.flatMap((e) => (e.kind === 'tool' ? [{ ...e, status: 'waiting' }, e] : [e]));
  check('gauge: tool-start events change nothing', gaugeSnapshot(withStarts, { now: t + 3000 }), gaugeSnapshot(base, { now: t + 3000 }));
  const withWait = [...base, { ts: t + 50_000, kind: 'permission', status: 'waiting' }];
  check('gauge: a permission wait is not progress', gaugeSnapshot(withWait, { now: t + 60_000 }), gaugeSnapshot(base, { now: t + 60_000 }));
  const sameFile = [1, 2, 3, 4, 5].map((i) => ok(t + i, 'Edit', { target: 'sha256:a' }));
  const manyFiles = [1, 2, 3, 4, 5].map((i) => ok(t + i, 'Edit', { target: `sha256:${i}` }));
  check('gauge: five edits to one file count as thrash', gaugeSnapshot(sameFile) > gaugeSnapshot(manyFiles), true);

  // ---- playback --------------------------------------------------------------------
  const evs = [0, 1000, 2000, 3000].map((ts) => ({ ts, kind: 'tool' }));
  const p = createPlayer(evs, { startTime: 0 });
  check('playback: only the first event has arrived at t=0', p.arrived, 1);
  p.play(); p.tick(1000); p.tick(2500);
  check('playback: 1.5 s at 1x shows 2 events', p.arrived, 2);
  p.setSpeed(2);
  check('playback: changing speed keeps it playing', p.playing, true);
  p.tick(3000);
  check('playback: 0.5 s at 2x advances 1 s', p.time, 2500);
  p.pause(); p.tick(999_999);
  check('playback: paused does not advance', p.time, 2500);
  const lp = createPlayer([]);
  lp.append([{ ts: 5000, kind: 'tool' }]);
  lp.append([{ ts: 6000, kind: 'tool_fail' }]);
  lp.seek(6000);
  check('playback: a live player shows appended events', lp.arrived, 2);
  check('playback: its duration spans them', lp.snapshot().duration, 1000);
  check('playback: a one-instant session ends at progress 1', createPlayer([{ ts: 5 }]).progress, 1);

  // ---- signal (events to waveform) ---------------------------------------------------
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const sig = createSignal({ random: rnd });
  const quiet = loudness(sig.frame(0).timeByteArray);
  check('signal: 1,024 samples per channel', sig.frame(16).timeByteArrayL.length, SAMPLES);
  check('signal: no events is near silence', quiet < 1, true);
  sig.hit({ kind: 'tool', status: 'ok', tool: 'Read' });
  const toolLoud = loudness(sig.frame(32).timeByteArray);
  const sig2 = createSignal({ random: rnd });
  sig2.frame(0);
  sig2.hit({ kind: 'tool_fail', tool: 'Bash' });
  const failLoud = loudness(sig2.frame(16).timeByteArray);
  check('signal: a tool call makes sound', toolLoud > 5, true);
  check('signal: a failure is louder than a tool call', failLoud > toolLoud, true);
  check('signal: sound decays within 3 s', loudness(sig.frame(3032).timeByteArray) < 1, true);
  sig.setTurbulence(1);
  check('signal: turbulence raises the floor', loudness(sig.frame(3048).timeByteArray) > 5, true);
  sig.hit({ kind: 'stop' });
  check('signal: unknown or stop events add no voice', sig.voices, 0);

  // ---- daemon ------------------------------------------------------------------------
  const sock = useSock('d.sock');
  const { port } = await start();
  check('daemon: socket is owner-only', (statSync(sock).mode & 0o777).toString(8), '600');
  check('daemon: state file is owner-only', (statSync(`${sock}.state`).mode & 0o777).toString(8), '600');
  let already = null;
  try { await start(); } catch (e) { already = e; }
  check('daemon: a second start reports AlreadyRunning', already instanceof AlreadyRunning, true);

  await writeEvent({ kind: 'tool', status: 'ok', tool: 'Bash', payload: 'SECRET', extra: 1 });
  await writeEvent({ type: 'PostToolUseFailure', tool: 'Bash', sig: 'sha256:' + 'a'.repeat(64), tool_input: { content: 'SECRET' } });
  await sleep(80);
  const two = await readSSE(port, { count: 2 });
  check('daemon: stream delivers both events', two.length, 2);
  check('daemon: hook envelope becomes a tool_fail', two[1]?.ev.kind, 'tool_fail');
  check('daemon: unknown fields never reach the stream', JSON.stringify(two).includes('SECRET') || JSON.stringify(two).includes('extra'), false);
  const resumed = await readSSE(port, { count: 5, ms: 400, headers: { 'Last-Event-ID': String(two[0].id) } });
  check('daemon: a reconnect gets only newer events', resumed.length, 1);

  // Malformed lines, unknown kinds and deep nesting on the raw socket.
  const deep = '['.repeat(5000) + ']'.repeat(5000);
  await new Promise((r) => {
    const c = createConnection(sock, () => c.end(`null\n[]\n{"kind":"bogus"}\n{"type":"Nope"}\n{"kind":"bogus","x":${deep}}\n`));
    c.on('close', r);
    c.on('error', r);
  });
  await sleep(80);
  const st1 = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  check('daemon: bad lines are dropped and the daemon lives', st1.events, 2);
  check('daemon: status counts connected pages', st1.pages, 0);
  check('daemon: GET // does not crash it', (await fetch(`http://127.0.0.1:${port}//`)).status, 404);
  const evil = await new Promise((resolve) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/status', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
  });
  check('daemon: a foreign Host header is refused', evil, 403);
  check('daemon: serves the page', (await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  const pageImports = [...readFileSync(join(ROOT, 'web', 'turbella.html'), 'utf8').matchAll(/from '\.\.\/src\/([a-z]+\.js)'/g)].map((m) => m[1]);
  let served = 0;
  for (const m of pageImports) if ((await fetch(`http://127.0.0.1:${port}/src/${m}`)).status === 200) served++;
  check(`daemon: serves all ${pageImports.length} page modules`, served, pageImports.length);
  check('daemon: serves the visualiser', (await fetch(`http://127.0.0.1:${port}/viz`)).status, 200);
  const vizModules = ['viz.js', ...[...readFileSync(join(ROOT, 'src', 'viz.js'), 'utf8').matchAll(/from '\.\/([a-z]+\.js)'/g)].map((m) => m[1])];
  let vizServed = 0;
  for (const m of vizModules) if ((await fetch(`http://127.0.0.1:${port}/src/${m}`)).status === 200) vizServed++;
  check(`daemon: serves all ${vizModules.length} visualiser modules`, vizServed, vizModules.length);
  check('daemon: serves the bundled engine', (await fetch(`http://127.0.0.1:${port}/vendor/butterchurn.min.js`)).status, 200);
  check('daemon: serves the bundled presets', (await fetch(`http://127.0.0.1:${port}/vendor/butterchurnPresets.min.js`)).status, 200);
  check('daemon: serves nothing else from vendor/', (await fetch(`http://127.0.0.1:${port}/vendor/LICENSE`)).status, 404);
  check('daemon: refuses paths outside src/', (await fetch(`http://127.0.0.1:${port}/src/%2e%2e/package.json`)).status, 404);

  // tailer: a hook names the transcript; new thinking lines become think events
  daemonClear();
  const transcript = join(TMP, 'session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', thinkingDurationMs: 999 }) + '\n'); // history: never replayed
  await writeEvent({ kind: 'ping', transcript });
  await sleep(200);
  appendFileSync(transcript, JSON.stringify({ type: 'assistant', sessionId: 's-t', timestamp: new Date().toISOString(), thinkingDurationMs: 4200 }) + '\n');
  await sleep(1500);
  check('tailer: a new thinking line becomes one think event', daemonState().byKind.think, 1);
  await stop();
  process.env.TURBELLA_IDLE_MS = '100';
  await start();
  await sleep(300);
  check('daemon: idle exit removes the socket and state', readState() === null && !existsSync(sock), true);
  delete process.env.TURBELLA_IDLE_MS;
  await stop();

  // ---- the real hook binary ------------------------------------------------------------
  useSock('h.sock');
  const h = await start();
  for (let i = 0; i < 5; i++) runHook({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } });
  await sleep(100);
  check('hook: delivers 5 of 5 events', daemonState().events, 5);
  daemonClear();
  runHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls', description: 'other words' } });
  runHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls /nope' } });
  runHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'a.js', old_string: 'x', new_string: 'y' } });
  await sleep(100);
  const hooked = await readSSE(h.port, { count: 3 });
  const lsSig = (await readClaudeFile(FIX('claude-clean.jsonl'))).find((e) => e.tool === 'Bash').sig;
  check('hook: same call hashes the same live and in replay', hooked[0]?.ev.sig, lsSig);
  check('hook: different arguments, different hash', hooked[1]?.ev.sig !== hooked[0]?.ev.sig, true);
  check('hook: an edit carries a file-path hash', /^sha256:/.test(hooked[2]?.ev.target ?? ''), true);
  // Codex payloads, in the shapes a real Codex 0.153 run sent.
  daemonClear();
  const cx = (extra) => ({ session_id: 'c', turn_id: 't', transcript_path: '/Users/x/.codex/sessions/2026/10/22/rollout-1.jsonl', model: 'm', ...extra });
  runHook(cx({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: a.txt\n-x\n+y\n*** End Patch' }, tool_response: 'Exit code: 1\nWall time: 0.1 seconds\nOutput:\nfailed\n' }));
  runHook(cx({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls /missing' }, tool_response: 'ls: /missing: No such file or directory\n' }));
  runHook(cx({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: b.txt\n+hi\n*** End Patch' }, tool_response: 'Exit code: 0\nOutput:\nSuccess.\n' }));
  await sleep(100);
  const codexEvs = (await readSSE(h.port, { count: 3 })).map((x) => x.ev);
  check('codex: events get the codex lane', codexEvs.every((e) => e.agent === 'codex'), true);
  check('codex: a patch with a non-zero exit code is a failure', codexEvs[0]?.kind, 'tool_fail');
  check('codex: a shell call is never guessed to have failed', codexEvs[1]?.kind, 'tool');
  check('codex: a patch carries its file-path hash', /^sha256:/.test(codexEvs[2]?.target ?? ''), true);
  daemonClear();
  runHook(cx({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'call-1', tool_input: { command: '*** Begin Patch\n*** Update File: nope.txt\n*** End Patch' } }));
  runHook(cx({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call-2', tool_input: { command: 'ls' } }));
  runHook(cx({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call-2', tool_input: { command: 'ls' }, tool_response: '' }));
  runHook(cx({ hook_event_name: 'Stop' }));
  runHook({ hook_event_name: 'PreToolUse', session_id: 'cl', tool_name: 'Bash', tool_use_id: 'x', tool_input: { command: 'ls' } });
  runHook({ hook_event_name: 'Stop', session_id: 'cl' });
  await sleep(150);
  check('codex: a call that never ended is a failure at Stop', daemonState().byKind.tool_fail, 1);
  check('codex: (Claude Code calls are not inferred)', daemonState().byKind.stop, 2);
  check('codex: session start prints nothing', runHook(cx({ hook_event_name: 'SessionStart', source: 'startup' })), '');
  const forced = execFileSync(process.execPath, [HOOK, '--agent', 'codex'], { input: JSON.stringify({ hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  check('codex: --agent codex overrides detection', forced, '');
  daemonClear();
  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hello' });
  await sleep(100);
  check('hook: a prompt submission becomes a turn event', daemonState().byKind.turn, 1);
  await stop();

  // what leaves the hook: a bare socket stands in for the daemon and records it
  const sniffSock = useSock('s.sock');
  let line = '';
  const sniff = createRawServer((s) => { s.setEncoding('utf8'); s.on('data', (d) => { line += d; }); });
  await new Promise((r) => sniff.listen(sniffSock, r));
  runHook({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Write', tool_input: { file_path: 'k.txt', content: 'SECRET-BODY' } });
  runHook({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Task', tool_input: { prompt: 'SECRET-PROMPT' } });
  runHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: 'k.txt' }, tool_response: 'SECRET-OUTPUT' });
  runHook({ hook_event_name: 'PostToolUseFailure', session_id: 's', tool_name: 'Bash', tool_input: {}, error: 'SECRET-ERROR' });
  runHook({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'SECRET-USER-PROMPT' });
  await sleep(100);
  await new Promise((r) => sniff.close(r));
  check('hook: forwarded 5 lines', line.trim().split('\n').length, 5);
  check('hook: a prompt submission is sent as its event name only', line.includes('"type":"UserPromptSubmit"'), true);
  check('hook: no file body, prompt, output or error text leaves it', /SECRET/.test(line), false);

  // no daemon running: the hook starts one; SessionStart prints its address
  useSock('a.sock');
  runHook({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: 'x' } });
  const auto = readState();
  check('hook: starts a daemon when none runs', !!auto?.pid, true);
  if (auto) check('hook: the started daemon got the event', (await (await fetch(`http://127.0.0.1:${auto.port}/status`)).json()).events, 1);
  const ssOut = runHook({ hook_event_name: 'SessionStart', session_id: 's' });
  check('hook: SessionStart prints the page address', ssOut.includes(`127.0.0.1:${readState()?.port}`), true);
  killStateDaemon();
  await sleep(200);

  // ---- CLI ---------------------------------------------------------------------------------
  useSock('c.sock');
  check('cli: emit prints nothing', execFileSync(process.execPath, [BIN, 'emit', '--kind', 'tool', '--tool', 'Bash', '--payload', '{"cmd":"ls"}'], { encoding: 'utf8' }), '');
  const status = JSON.parse(execFileSync(process.execPath, [BIN, 'status'], { encoding: 'utf8' }));
  check('cli: emit started a daemon and status sees the event', status.events, 1);
  check('cli: status reports the gauge', typeof status.gauge, 'number');
  const rep = JSON.parse(execFileSync(process.execPath, [BIN, 'replay', FIX('claude-retry-loop.jsonl')], { encoding: 'utf8' }));
  check('cli: replay counts the fixture failures', rep.byKind.tool_fail, 2);
  check('cli: replay output carries no transcript text', /git push|failed to push/.test(JSON.stringify(rep)), false);
  killStateDaemon();
  await sleep(200);
  useSock('s2.sock');
  const st2 = JSON.parse(execFileSync(process.execPath, [BIN, 'status'], { encoding: 'utf8' }));
  check('cli: status starts the daemon when none runs', st2.events, 0);
  killStateDaemon();
  await sleep(200);

  // ---- parity: every door matches the manifest ---------------------------------------------
  const daemonNames = toolsFor('daemon').map((x) => x.name).sort();
  check('parity: one CLI/MCP handler per daemon tool, no extras', JSON.stringify(Object.keys(HANDLERS).sort()), JSON.stringify(daemonNames));
  check('parity: every manifest entry states personOnly', MANIFEST.every((x) => typeof x.personOnly === 'boolean'), true);
  const html = readFileSync(join(ROOT, 'web', 'turbella.html'), 'utf8');
  const controls = [...html.matchAll(/<(button|select|input)\b[^>]*>/g)].map((m) => m[0]);
  check('parity: every page control names its tool', controls.every((c) => /data-tool="/.test(c)), true);
  const pageNames = [...new Set(controls.flatMap((c) => c.match(/data-tool="([^"]+)"/)[1].split(' ')))].sort();
  check('parity: page controls cover exactly the page tools', JSON.stringify(pageNames), JSON.stringify(toolsFor('page').map((x) => x.name).sort()));
  const vizControls = [...readFileSync(join(ROOT, 'web', 'viz.html'), 'utf8').matchAll(/<(button|select|input)\b[^>]*>/g)].map((m) => m[0]);
  check('parity: every visualiser control names its tool', vizControls.every((c) => /data-tool="/.test(c)), true);
  const vizNames = [...new Set(vizControls.flatMap((c) => c.match(/data-tool="([^"]+)"/)[1].split(' ')))].sort();
  check('parity: visualiser controls cover exactly the viz tools', JSON.stringify(vizNames), JSON.stringify(toolsFor('viz').map((x) => x.name).sort()));

  // ---- MCP server ------------------------------------------------------------------------------
  useSock('m.sock');
  await start();
  const proc = spawn(process.execPath, [MCP_BIN], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  const call = async (id, method, params = {}) => {
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (let i = 0; i < 50 && !out.includes(`"id":${id}`); i++) await sleep(50);
    return JSON.parse(out.split('\n').find((l) => l.includes(`"id":${id}`)));
  };
  check('mcp: initialize', (await call(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} })).result.serverInfo.name, 'turbella');
  const listed = (await call(2, 'tools/list')).result.tools.map((x) => x.name).sort();
  check('mcp: tools/list matches the manifest', JSON.stringify(listed), JSON.stringify(daemonNames.map((n) => 'turbella_' + n)));
  check('mcp: status tool returns status', (await call(3, 'tools/call', { name: 'turbella_status', arguments: {} })).result.content[0].text.includes('"gauge"'), true);
  const r4 = await call(4, 'tools/call', { name: 'turbella_replay', arguments: { path: FIX('claude-retry-loop.jsonl') } });
  check('mcp: replay matches the CLI', JSON.parse(r4.result.content[0].text).byKind.tool_fail, 2);
  proc.stdin.write('null\n');
  await sleep(100);
  check('mcp: a null line gets an error reply', out.includes('"code":-32600'), true);
  check('mcp: and the server keeps running', (await call(5, 'ping')).result !== undefined, true);
  check('mcp: resources/read returns status', (await call(6, 'resources/read', { uri: 'turbella://status' })).result.contents[0].uri, 'turbella://status');
  proc.kill();
  await stop();
}

main()
  .catch((e) => { failures++; console.error('verify crashed:', e); })
  .finally(async () => {
    try { killStateDaemon(); } catch {}
    rmSync(TMP, { recursive: true, force: true });
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
