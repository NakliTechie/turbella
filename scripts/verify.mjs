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
import { HANDLERS, shippedNativeIsCurrent } from '../src/tools.js';

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
const runHook = (payload, env = {}) => execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env } });

// Read SSE events until `count` arrive or `ms` pass.
async function readSSE(port, { count = 1, ms = 1500, headers = {}, path = '/events' } = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: ctrl.signal, headers });
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
  const thrash = (tool) => Array.from({ length: 5 }, (_, i) => ({ ts: t + i * 1000, kind: 'tool', status: 'ok', tool, target: 'sha256:' + 'a'.repeat(64) }));
  check('gauge: edit thrash counts lowercase edit tools (opencode, pi, omp)', gaugeSnapshot(thrash('edit'), { now: t + 5000 }), gaugeSnapshot(thrash('Edit'), { now: t + 5000 }));
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
  check('signal: no events is a faint breath, never flat', quiet > 0.5 && quiet < 5, true);
  sig.hit({ kind: 'tool', status: 'ok', tool: 'Read' });
  const toolLoud = loudness(sig.frame(32).timeByteArray);
  const sig2 = createSignal({ random: rnd });
  sig2.frame(0);
  sig2.hit({ kind: 'tool_fail', tool: 'Bash' });
  const failLoud = loudness(sig2.frame(16).timeByteArray);
  check('signal: a tool call makes sound', toolLoud > 5, true);
  check('signal: a failure is louder than a tool call', failLoud > toolLoud, true);
  sig.frame(3032);
  check('signal: a pluck decays within 3 s', sig.voices, 0);
  sig.hit({ kind: 'stop' });
  sig.frame(6000);
  sig.setTurbulence(1);
  check('signal: turbulence raises the floor', loudness(sig.frame(6016).timeByteArray) > 5, true);
  sig.setTurbulence(0);
  sig.hit({ kind: 'stop' });
  check('signal: unknown or stop events add no voice', sig.voices, 0);

  // A running tool and an open turn keep the picture moving between hooks.
  const sig3 = createSignal({ random: rnd });
  const idleLoud = loudness(sig3.frame(0).timeByteArray);
  sig3.hit({ kind: 'turn', session: 's' }, 0);
  sig3.hit({ kind: 'tool', status: 'waiting', tool: 'Grep', session: 's', sig: 'a' }, 0);
  check('signal: a running tool holds its tone after 5 s', loudness(sig3.frame(5000).timeByteArray) > 10, true);
  check('signal: the running tool is counted', sig3.running, 1);
  sig3.hit({ kind: 'tool', status: 'ok', tool: 'Grep', session: 's', sig: 'a' }, 5000);
  check('signal: the tool end releases it', sig3.running, 0);
  const workLoud = loudness(sig3.frame(15000).timeByteArray);
  check('signal: an open turn stays above idle', workLoud > idleLoud * 2, true);
  sig3.hit({ kind: 'tool', status: 'waiting', tool: 'Bash', session: 's', sig: 'b' }, 15000);
  sig3.frame(15000 + 121000);
  check('signal: a tool held past 2 minutes is let go', sig3.running, 0);
  sig3.hit({ kind: 'stop', session: 's' }, 136000);
  check('signal: stop ends the turn', sig3.working, false);
  check('signal: after stop it falls back to the idle breath', loudness(sig3.frame(150000).timeByteArray) < workLoud, true);

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
  // Copilot CLI payloads, in the shapes a real Copilot 1.0.97 run sent through the plugin.
  daemonClear();
  const cp = (extra) => ({ session_id: 'p', timestamp: 1792653216751, cwd: '/tmp/x', ...extra });
  runHook(cp({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls /missing' }, tool_result: { result_type: 'success', text_result_for_llm: 'ls: /missing: No such file or directory\n<shellId: 1 completed with exit code 1>' } }));
  runHook(cp({ hook_event_name: 'PostToolUse', timestamp: '2026-10-22T07:13:36.751Z', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_result: { result_type: 'success', text_result_for_llm: '\n<shellId: 0 completed with exit code 0>' } }));
  runHook({ hookName: 'permissionRequest', sessionId: 'p', timestamp: 1792653216751, toolName: 'bash', toolInput: { command: 'ls' } });
  runHook(cp({ hook_event_name: 'Stop', transcript_path: '/Users/x/.copilot/session-state/p/events.jsonl', stop_reason: 'end_turn' }));
  await sleep(150);
  const cpEvs = (await readSSE(h.port, { count: 4 })).map((x) => x.ev);
  check('copilot: events get the copilot lane', cpEvs.length === 4 && cpEvs.every((e) => e.agent === 'copilot'), true);
  check('copilot: a shell call with exit code 1 is a failure', cpEvs[0]?.kind, 'tool_fail');
  check('copilot: exit code 0 is a normal call', cpEvs[1]?.kind, 'tool');
  check('copilot: a camelCase permission request is kept', cpEvs[2]?.kind, 'permission');
  check('copilot: session start prints nothing', runHook(cp({ hook_event_name: 'SessionStart', source: 'new' })), '');

  // Cursor payloads, in the shapes its hooks reference documents.
  daemonClear();
  const cu = (extra) => ({ conversation_id: 'u', generation_id: 'g', cursor_version: '2.0', transcript_path: '/Users/x/.cursor/projects/p/agent-transcripts/u.jsonl', ...extra });
  runHook(cu({ hook_event_name: 'beforeSubmitPrompt', prompt: 'SECRET' }));
  runHook(cu({ hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: { command: 'ls' }, tool_output: 'a.txt', tool_use_id: 'k', duration: 120 }));
  runHook(cu({ hook_event_name: 'postToolUseFailure', tool_name: 'Shell', tool_input: { command: 'make' }, error_message: 'exit 2', failure_type: 'error', duration: 900 }));
  runHook(cu({ hook_event_name: 'afterAgentThought', text: 'SECRET-THOUGHT', duration_ms: 4200 }));
  runHook(cu({ hook_event_name: 'stop', status: 'completed' }));
  await sleep(150);
  const cuEvs = (await readSSE(h.port, { count: 5 })).map((x) => x.ev);
  check('cursor: events get the cursor lane', cuEvs.length === 5 && cuEvs.every((e) => e.agent === 'cursor'), true);
  check('cursor: kinds map (turn, tool, failure, think, stop)', cuEvs.map((e) => e.kind).join(','), 'turn,tool,tool_fail,think,stop');
  check('cursor: tool duration comes through', cuEvs[1]?.dur_ms, 120);
  check('cursor: thinking time comes through, its text does not', cuEvs[3]?.dur_ms === 4200 && !JSON.stringify(cuEvs).includes('SECRET'), true);
  check('cursor: session start prints nothing', runHook(cu({ hook_event_name: 'sessionStart', session_id: 'u' })), '');

  // Hermes shell-hook payloads, in the wire shape agent/shell_hooks.py documents.
  daemonClear();
  const he = (event, extra = {}, top = {}) => ({ hook_event_name: event, session_id: 'hs', cwd: '/w', extra, ...top });
  runHook(he('pre_llm_call', { user_message: 'SECRET', is_first_turn: true }));
  runHook(he('post_tool_call', { status: 'ok', duration_ms: 42, tool_call_id: 'c1', result: 'SECRET-OUT' }, { tool_name: 'terminal', tool_input: { command: 'ls' } }));
  runHook(he('post_tool_call', { status: 'error', error_message: 'SECRET-ERR', duration_ms: 7, tool_call_id: 'c2' }, { tool_name: 'terminal', tool_input: { command: 'make' } }));
  runHook(he('post_tool_call', { status: 'blocked', tool_call_id: 'c3' }, { tool_name: 'terminal', tool_input: { command: 'rm' } }));
  runHook(he('pre_approval_request', { command: 'rm -rf x' }));
  runHook(he('on_session_end', { completed: true }));
  await sleep(150);
  const heEvs = (await readSSE(h.port, { count: 6 })).map((x) => x.ev);
  check('hermes: events get the hermes lane', heEvs.length === 6 && heEvs.every((e) => e.agent === 'hermes'), true);
  check('hermes: kinds map (turn, tool, failure, blocked, permission, stop)', heEvs.map((e) => e.kind).join(','), 'turn,tool,tool_fail,tool_fail,permission,stop');
  check('hermes: duration comes from extra', heEvs[1]?.dur_ms, 42);
  check('hermes: no prompt, output or error text', !JSON.stringify(heEvs).includes('SECRET'), true);
  check('hermes: session start prints nothing (stdout is a hook decision)', runHook(he('on_session_start', { platform: 'cli' })), '');
  // Hermes waits for each hook, so the hook hands off and returns even when no daemon can be reached.
  const t0 = Date.now();
  runHook(he('post_tool_call', { status: 'ok' }, { tool_name: 'terminal', tool_input: { command: 'ls' } }), { TURBELLA_SOCK: '/nonexistent-turbella/x.sock' });
  check('hermes: the hook returns in under 500 ms with no daemon reachable', Date.now() - t0 < 500, true);

  // Sessions and filters: one floating window per session, and `turbella run`
  // strips that show only their own agent (TURBELLA_RUN).
  daemonClear();
  runHook({ hook_event_name: 'PostToolUseFailure', session_id: 'wrapped', tool_name: 'Bash', tool_input: { command: 'make' }, error: 'x' }, { TURBELLA_RUN: 'r1' });
  runHook({ hook_event_name: 'PostToolUseFailure', session_id: 'wrapped', tool_name: 'Bash', tool_input: { command: 'make' }, error: 'x' }, { TURBELLA_RUN: 'r1' });
  runHook({ hook_event_name: 'PostToolUse', session_id: 'other', tool_name: 'Read', tool_input: { file_path: '/a' } });
  runHook({ hook_event_name: 'Stop', session_id: 'other' });
  await sleep(150);
  const st = async (q = '') => (await fetch(`http://127.0.0.1:${h.port}/status${q}`)).json();
  const whole = await st();
  check('sessions: status lists active sessions, newest first', whole.sessions.map((x) => x.session).join(','), 'other,wrapped');
  check('sessions: the run tag comes through the hook', whole.sessions[1].run, 'r1');
  check('sessions: a session whose last event is stop says so', whole.sessions[0].stopped, true);
  const byRun = await st('?run=r1');
  check('filter: ?run= counts only that wrapper\'s events', byRun.events === 2 && byRun.byKind.tool_fail === 2, true);
  check('filter: ?session= counts only that session', (await st('?session=other')).events, 2);
  check('filter: the gauge is per filter (failures in one session only)', byRun.gauge > (await st('?session=other')).gauge, true);
  check('filter: a filtered status lists no sessions', byRun.sessions, undefined);
  const code = async (path) => (await fetch(`http://127.0.0.1:${h.port}${path}`)).status;
  check('guide: the daemon serves the built guide and its screenshots', [await code('/guide/'), await code('/guide/screenshots/02-timeline-live.png')].join(','), '200,200');
  check('guide: only plain screenshot names are served', [await code('/guide/screenshots/..%2Fcapture.mjs'), await code('/guide/capture.mjs')].join(','), '404,404');
  const streamed = (await readSSE(h.port, { count: 3, ms: 800, path: '/events?session=other' })).map((x) => x.ev);
  check('filter: /events?session= streams only that session, backlog included', streamed.length === 2 && streamed.every((e) => e.session === 'other'), true);

  // A busy session stays listed past 15 minutes; a stopped one does not.
  daemonClear();
  const old = Date.now() - 20 * 60_000;
  await writeEvent({ kind: 'tool', status: 'waiting', tool: 'Bash', session: 'long-call', agent: 'x', ts: old });
  await writeEvent({ kind: 'turn', session: 'mid-turn', agent: 'x', ts: old });
  await writeEvent({ kind: 'stop', session: 'done', agent: 'x', ts: old });
  await sleep(100);
  const busy = (await st()).sessions.map((x) => x.session).sort().join(',');
  check('sessions: an open call or an unfinished turn keeps a session past 15 min; a stopped one ages out', busy, 'long-call,mid-turn');

  // In-process adapters, driven with each agent's documented event shapes.
  daemonClear();
  const { TurbellaPlugin } = await import('../adapters/opencode.js');
  const oc = await TurbellaPlugin({});
  const ocTool = (status, extra = {}) => ({ type: 'message.part.updated', properties: { part: { id: 'p1', sessionID: 'oc1', messageID: 'm', type: 'tool', callID: 'c1', tool: 'bash', state: { status, input: { command: 'make' }, ...extra } } } });
  await oc['chat.message']({ sessionID: 'oc1' }, {});
  await oc.event({ event: ocTool('running', { time: { start: 1000 } }) });
  await oc.event({ event: ocTool('running', { time: { start: 1000 } }) });
  await oc.event({ event: ocTool('completed', { output: 'SECRET-OUT', title: '', metadata: { exit: 2 }, time: { start: 1000, end: 1400 } }) });
  await oc.event({ event: { type: 'message.part.updated', properties: { part: { id: 'r1', sessionID: 'oc1', messageID: 'm', type: 'reasoning', text: 'SECRET-THINK', time: { start: 0, end: 2500 } } } } });
  await oc.event({ event: { type: 'session.idle', properties: { sessionID: 'oc1' } } });
  await sleep(300);
  const ocEvs = (await readSSE(h.port, { count: 5 })).map((x) => x.ev);
  const shape = (evs) => evs.map((e) => e.kind + (e.status === 'waiting' ? '*' : '')).join(',');
  check('opencode: turn, one start, shell exit 2 fails, think, stop', shape(ocEvs), 'turn,tool*,tool_fail,think,stop');
  check('opencode: lane and durations; no output or thinking text', ocEvs.every((e) => e.agent === 'opencode') && ocEvs[2].dur_ms === 400 && ocEvs[3].dur_ms === 2500 && !JSON.stringify(ocEvs).includes('SECRET'), true);

  daemonClear();
  const on = {};
  const { turbellaExtension } = await import('../adapters/pi.js');
  turbellaExtension('omp')({ on: (name, fn) => { on[name] = fn; } });
  const ctx = { sessionManager: { getSessionId: () => 'pi1' } };
  await on.agent_start({ prompt: 'SECRET' }, ctx);
  await on.tool_execution_start({ toolCallId: 't1', toolName: 'edit', args: { path: '/a.js', oldText: 'SECRET' } }, ctx);
  await on.tool_execution_end({ toolCallId: 't1', toolName: 'edit', result: { content: [{ type: 'text', text: 'SECRET-ERR' }] }, isError: true }, ctx);
  await on.tool_execution_start({ toolCallId: 't2', toolName: 'read', args: { path: '/a.js' } }, ctx);
  await on.tool_execution_end({ toolCallId: 't2', toolName: 'read', result: {}, isError: false }, ctx);
  await on.agent_end({}, ctx);
  await sleep(300);
  const piEvs = (await readSSE(h.port, { count: 6 })).map((x) => x.ev);
  check('pi/omp: turn, start, failure, start, end, stop in order', shape(piEvs), 'turn,tool*,tool_fail,tool*,tool,stop');
  check('pi/omp: lane, session, edited file hashed as target; no text', piEvs.every((e) => e.agent === 'omp' && e.session === 'pi1') && /^sha256:/.test(piEvs[1].target ?? '') && !JSON.stringify(piEvs).includes('SECRET'), true);

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
  check('cli: status reports the contract schema (docs/PLUGINS.md)', status.schema, 1);
  execFileSync(process.execPath, [BIN, 'emit', '--agent', 'myagent', '--kind', 'tool_fail', '--status', 'error', '--tool', 'terminal', '--payload', 'exit 2']);
  await sleep(100);
  const emitted = (await readSSE(readState().port, { count: 2 })).map((x) => x.ev);
  check('cli: emit --agent sets the lane; the default lane is emit', emitted.map((e) => e.agent).join(','), 'emit,myagent');
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

  // ---- install ------------------------------------------------------------------------------
  const home = join(TMP, 'home');
  const cursorFile = join(home, '.cursor', 'hooks.json');
  execFileSync('mkdir', ['-p', join(home, '.cursor')]);
  writeFileSync(cursorFile, JSON.stringify({ version: 1, hooks: { stop: [{ command: 'mine.sh' }] } }));
  const inst = (agent) => JSON.parse(execFileSync(process.execPath, [BIN, 'install', agent], { encoding: 'utf8', env: { ...process.env, HOME: home } }));
  check('install: cursor adds 8 hooks', inst('cursor').added, 8);
  const written = JSON.parse(readFileSync(cursorFile, 'utf8'));
  check('install: keeps the hook that was there', written.hooks.stop.some((x) => x.command === 'mine.sh'), true);
  check('install: never touches a permission hook', 'preToolUse' in written.hooks, false);
  check('install: a second run adds nothing', inst('cursor').added, 0);
  check('install: other agents get commands, no file change', Array.isArray(inst('copilot').run), true);
  check('install: hermes prints a hooks block for all 8 events', (inst('hermes').run[0].match(/--agent hermes/g) || []).length, 8);
  for (const [agent, file] of [['opencode', '.config/opencode/plugin/turbella.js'], ['pi', '.pi/agent/extensions/turbella.ts'], ['omp', '.omp/agent/extensions/turbella.ts']]) {
    check(`install: ${agent} writes one re-export file`, inst(agent).added === 1 && readFileSync(join(home, file), 'utf8').includes(`adapters/${agent}.js`), true);
    check(`install: ${agent} a second run writes nothing`, inst(agent).added, 0);
  }

  // ---- parity: every door matches the manifest ---------------------------------------------
  const daemonNames = toolsFor('daemon').map((x) => x.name).sort();
  check('parity: one CLI/MCP handler per daemon tool, no extras', JSON.stringify(Object.keys(HANDLERS).sort()), JSON.stringify(daemonNames));
  check('native: the shipped helper was built from the current Swift source (npm run build:native)', shippedNativeIsCurrent(), true);
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
  const agentNames = toolsFor('daemon').filter((x) => !x.personOnly).map((x) => 'turbella_' + x.name).sort();
  check('mcp: tools/list matches the manifest, person-only tools left out', JSON.stringify(listed), JSON.stringify(agentNames));
  check('mcp: install cannot be called over MCP', (await call(7, 'tools/call', { name: 'turbella_install', arguments: { agent: 'cursor' } })).result.isError, true);
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
