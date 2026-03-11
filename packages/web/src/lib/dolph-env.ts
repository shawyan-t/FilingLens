import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

async function applyEnvFile(filePath: string, override: boolean) {
  try {
    const raw = await readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!override && process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  } catch {
    // Missing env files are acceptable in web runtime.
  }
}

let loadPromise: Promise<void> | null = null;

export async function loadDolphEnv() {
  if (!loadPromise) {
    loadPromise = (async () => {
      await applyEnvFile(resolve(process.cwd(), '.env'), false);
      await applyEnvFile(resolve(homedir(), '.dolph/.env'), true);
    })();
  }
  await loadPromise;
}
