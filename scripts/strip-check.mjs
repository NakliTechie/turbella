#!/usr/bin/env node
// Checks `turbella run`'s strip against the same program run without it, in
// tmux (macOS, needs tmux):
//   paste   a 200 KB paste (Devanagari, emoji, ASCII, escape sequences) with
//           bracketed paste on arrives byte for byte as it does unwrapped
//   screen  vim, less and a scroll-region script draw the same screen under the
//           strip as unwrapped in a pane one row shorter
// Generated files live in one temp directory, deleted at the end.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/turbella', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'turbella-strip-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmux = (...a) => execFileSync('tmux', a, { encoding: 'utf8' });
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} strip: ${name}${ok ? '' : ` ${detail}`}`); if (!ok) failed++; };

// Run `cmd` (a shell line) in a detached tmux pane, wrapped or not; returns the session name.
const ROWS = 24, COLS = 100;
function open(name, cmd, wrapped) {
  const line = wrapped ? `${JSON.stringify(process.execPath)} ${JSON.stringify(BIN)} run -- sh -c ${JSON.stringify(cmd)}` : cmd;
  // remain-on-exit keeps a pane whose program quit, so its last screen is compared
  // instead of the tmux server going away.
  tmux('new-session', '-d', '-s', name, '-x', String(COLS), '-y', String(wrapped ? ROWS : ROWS - 1), line,
    ';', 'set-option', '-t', name, 'remain-on-exit', 'on');
  return name;
}
const screen = (name, wrapped) => tmux('capture-pane', '-p', '-t', name).split('\n').slice(wrapped ? 1 : 0, (wrapped ? 1 : 0) + ROWS - 1);
const close = (name) => { try { tmux('kill-session', '-t', name); } catch {} };

try {
  // ---- paste ---------------------------------------------------------------
  const piece = 'नमस्ते दुनिया 🙂🎛️ plain ascii \x1b[1;2A ok\n';
  writeFileSync(join(dir, 'paste.txt'), piece.repeat(Math.ceil(200_000 / Buffer.byteLength(piece))));
  for (const wrapped of [false, true]) {
    const out = join(dir, wrapped ? 'out-wrapped' : 'out-plain');
    const s = open(wrapped ? 'tbstrip-pw' : 'tbstrip-pp', `stty raw -echo; printf '\\033[?2004h'; cat > ${out}`, wrapped);
    await sleep(1500);
    tmux('load-buffer', '-b', 'tbstrip', join(dir, 'paste.txt'));
    tmux('paste-buffer', '-r', '-p', '-b', 'tbstrip', '-t', s);
    await sleep(3000);
    close(s);
  }
  const plain = readFileSync(join(dir, 'out-plain'));
  const wrapped = existsSync(join(dir, 'out-wrapped')) ? readFileSync(join(dir, 'out-wrapped')) : Buffer.alloc(0);
  check('a 200 KB bracketed paste is byte-identical to unwrapped', plain.length > 200_000 && plain.equals(wrapped),
    `(plain ${plain.length} B, wrapped ${wrapped.length} B)`);

  // ---- screen --------------------------------------------------------------
  writeFileSync(join(dir, 'lines.txt'), Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'·'.repeat(i % 40)}`).join('\n'));
  writeFileSync(join(dir, 'region.sh'), [
    "printf '\\033[2J\\033[1;1Htop row\\033[5;12r\\033[5;1H'",
    'i=0; while [ $i -lt 30 ]; do echo "scrolled $i"; i=$((i+1)); done',
    "printf '\\033[r\\033[20;30Habsolute 20,30\\033[3dvpa row 3\\033[1;1H'",
    'sleep 30',
  ].join('\n'));
  const cases = [
    ['vim', `vim -u NONE -N ${join(dir, 'lines.txt')}`, ['150G', ':set nu', 'Enter', '/line 120', 'Enter']],
    // Without a UTF-8 charset, less asks whether the file is binary and quits on the next key.
    ['less', `LESSCHARSET=utf-8 less ${join(dir, 'lines.txt')}`, ['G', 'k', 'k']],
    ['scroll region', `sh ${join(dir, 'region.sh')}`, []],
  ];
  for (const [label, cmd, keys] of cases) {
    const shots = [];
    for (const wrapped of [false, true]) {
      const s = open(`tbstrip-${wrapped ? 'w' : 'p'}`, cmd, wrapped);
      await sleep(1500);
      for (const k of keys) { tmux('send-keys', '-t', s, k); await sleep(200); }
      await sleep(800);
      shots.push(screen(s, wrapped));
      close(s);
    }
    const diff = shots[0].findIndex((row, i) => row !== shots[1][i]);
    check(`${label} draws the same screen under the strip`, diff === -1,
      diff === -1 ? '' : `(row ${diff + 1}: ${JSON.stringify(shots[0][diff])} vs ${JSON.stringify(shots[1][diff])})`);
  }
} finally {
  for (const s of ['tbstrip-pp', 'tbstrip-pw', 'tbstrip-p', 'tbstrip-w']) close(s);
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? `${failed} STRIP CHECK(S) FAILED` : 'ALL STRIP CHECKS PASSED');
process.exit(failed ? 1 : 0);
