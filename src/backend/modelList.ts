import { execFile } from 'child_process';

export interface PiModelInfo {
  provider: string;
  modelId: string;
  fullName: string;
}

export async function listAvailableModels(backendChoice: string): Promise<PiModelInfo[]> {
  if (backendChoice === 'kiro-cli') {
    return await listKiroModels();
  }

  return await listPiModels();
}

async function listPiModels(): Promise<PiModelInfo[]> {
  return new Promise((resolve) => {
    execFile('pi', ['--list-models'], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const models: PiModelInfo[] = [];
      const lines = stdout.split('\n');

      for (const line of lines) {
        const parts = line.split(/\s{2,}/).map(s => s.trim());
        if (parts.length >= 2 && parts[0] !== 'provider') {
          const provider = parts[0];
          const modelId = parts[1];
          if (provider && modelId) {
            models.push({ provider, modelId, fullName: `${provider}/${modelId}` });
          }
        }
      }

      resolve(models);
    });
  });
}

async function listKiroModels(): Promise<PiModelInfo[]> {
  return new Promise((resolve) => {
    execFile('kiro-cli', ['chat', '--list-models'], { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }

      const models: PiModelInfo[] = [];
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

      resolve(models);
    });
  });
}
