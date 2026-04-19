import { execFile } from 'child_process';
import * as fs from 'fs';

export interface ModelInfo {
  provider: string;
  modelId: string;
  fullName: string;
}

export async function listAvailableModels(backendChoice: string, log?: (message: string) => void): Promise<ModelInfo[]> {
  if (backendChoice === 'kiro-cli') {
    return await listKiroModels(log);
  }

  return await listPiModels(log);
}

async function listPiModels(log?: (message: string) => void): Promise<ModelInfo[]> {
  const command = resolveCommand('pi', [
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi'
  ]);

  return new Promise((resolve) => {
    execFile(command, ['--list-models'], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        emitLog(log, `[Cicerone] Failed to list pi models via ${command}: ${error.message}${stderr ? `\n${stderr}` : ''}`);
        resolve([]);
        return;
      }

      const text = [stdout, stderr].filter(Boolean).join('\n');
      const models: ModelInfo[] = [];

      for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (!line || line.toLowerCase().startsWith('provider')) {
          continue;
        }

        const parts = line.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          continue;
        }

        const provider = parts[0];
        const modelId = parts[1];
        models.push({ provider, modelId, fullName: `${provider}/${modelId}` });
      }

      if (models.length === 0) {
        const preview = text.trim().slice(0, 1000) || '(empty stdout/stderr)';
        emitLog(log, `[Cicerone] pi model discovery via ${command} returned no parseable rows.`);
        emitLog(log, `[Cicerone] Raw pi model output preview:\n${preview}`);
      }

      resolve(models);
    });
  });
}

async function listKiroModels(log?: (message: string) => void): Promise<ModelInfo[]> {
  const command = resolveCommand('kiro-cli', [
    '/opt/homebrew/bin/kiro-cli',
    '/usr/local/bin/kiro-cli'
  ]);

  return new Promise((resolve) => {
    execFile(command, ['chat', '--list-models'], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        emitLog(log, `[Cicerone] Failed to list kiro models via ${command}: ${error.message}${stderr ? `\n${stderr}` : ''}`);
        resolve([]);
        return;
      }

      const models: ModelInfo[] = [];
      for (const rawLine of stdout.split('\n')) {
        const line = rawLine.replace(/^\s*\*?\s*/, '').trim();
        if (!line || line.startsWith('Available models')) {
          continue;
        }

        const parts = line.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
        const modelId = parts[0];
        if (!modelId) {
          continue;
        }

        models.push({
          provider: 'kiro-cli',
          modelId,
          fullName: modelId
        });
      }

      if (models.length === 0) {
        emitLog(log, `[Cicerone] kiro model discovery via ${command} returned no parseable rows.`);
      }

      resolve(models);
    });
  });
}

function resolveCommand(command: string, fallbackPaths: string[]): string {
  for (const candidate of fallbackPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return command;
}

function emitLog(log: ((message: string) => void) | undefined, message: string): void {
  if (log) {
    log(message);
  }
}
