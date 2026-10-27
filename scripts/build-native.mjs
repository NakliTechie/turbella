#!/usr/bin/env node
// Builds the shipped native helper: a universal (arm64 + x86_64) binary at
// native/turbella-native, and native/turbella-native.sha256 with the hash of
// the Swift source it came from. `turbella overlay` and `run` use the shipped
// binary only while that hash matches the source; `npm run verify` checks it.
// Run on macOS after any change to native/turbella-native.swift.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../native/turbella-native.swift', import.meta.url));
const out = fileURLToPath(new URL('../native/turbella-native', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'turbella-native-'));
try {
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const file = join(tmp, arch);
    execFileSync('swiftc', ['-O', '-swift-version', '5', '-target', `${arch}-apple-macos12`, '-o', file, src], { stdio: 'inherit' });
    return file;
  });
  execFileSync('lipo', ['-create', '-output', out, ...slices]);
  execFileSync('codesign', ['--force', '--sign', '-', out]);
  const hash = createHash('sha256').update(readFileSync(src)).digest('hex');
  writeFileSync(`${out}.sha256`, `${hash}  turbella-native.swift\n`);
  console.log(`built ${out} (${execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim()}), source ${hash.slice(0, 12)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
