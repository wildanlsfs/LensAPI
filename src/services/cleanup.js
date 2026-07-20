// node-cron retention cleanup job (PRD §3.3, Phase 4).
//
// Per Phase 0 findings, node-cron v4.6.0's documented API is simply
// `cron.schedule(pattern, callback)` (5-field cron, callback fires at that
// time, server-local timezone by default). We stick to that documented form
// only — no extra options (noOverlap, distributed, timezone, etc.) since
// none of those are called for by PRD §4 or the Phase 0 notes.
import fs from 'node:fs/promises';
import path from 'node:path';

import cron from 'node-cron';

import config from '../config.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Filenames that must never be deleted by the cleanup job even if they sit
// in STORAGE_PATH — the tracked .gitkeep placeholder that keeps the
// (gitignored-contents) storage directory present in git.
const PROTECTED_FILENAMES = new Set(['.gitkeep']);

// Scans config.STORAGE_PATH and deletes any file whose mtime is older than
// config.RETENTION_DAYS days. Exported standalone (not just via the cron
// wrapper) so it can be invoked directly in tests/manual verification
// without waiting for a real cron trigger.
//
// Resilient by design: a failure reading/stating/deleting one entry is
// logged and skipped, it never aborts the rest of the run.
export async function runCleanup() {
  const storagePath = config.STORAGE_PATH;
  const retentionMs = config.RETENTION_DAYS * MS_PER_DAY;
  const now = Date.now();

  let entries;
  try {
    entries = await fs.readdir(storagePath, { withFileTypes: true });
  } catch (err) {
    console.error(`[cleanup] Failed to read STORAGE_PATH (${storagePath}):`, err);
    return { deletedCount: 0, bytesFreed: 0 };
  }

  let deletedCount = 0;
  let bytesFreed = 0;

  for (const entry of entries) {
    // Skip non-file entries (subdirectories, symlinks-to-dirs, etc.) — only
    // ever touch plain files directly inside STORAGE_PATH.
    if (!entry.isFile()) continue;

    // Never delete protected/tracked placeholder files.
    if (PROTECTED_FILENAMES.has(entry.name)) continue;

    const filePath = path.join(storagePath, entry.name);

    try {
      const stats = await fs.stat(filePath);
      const age = now - stats.mtimeMs;

      if (age > retentionMs) {
        await fs.unlink(filePath);
        deletedCount += 1;
        bytesFreed += stats.size;
      }
    } catch (err) {
      // Per-file errors (e.g. file removed by something else between stat
      // and unlink, permission issues) must not crash the whole run.
      console.error(`[cleanup] Failed to process file "${filePath}":`, err);
    }
  }

  console.log(
    `[cleanup] Run complete: deleted ${deletedCount} file(s), freed ${bytesFreed} bytes.`
  );

  return { deletedCount, bytesFreed };
}

// Registers the daily retention job per PRD §3.3 / Phase 0
// (`cron.schedule('0 3 * * *', callback)` — 03:00 server time, daily).
// Returns the scheduled task handle.
export function scheduleCleanup() {
  const task = cron.schedule('0 3 * * *', runCleanup);
  console.log('[cleanup] Scheduled daily retention cleanup job (0 3 * * *).');
  return task;
}
