import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { platform } from 'os';
import { ParsedCommand } from './command';

export interface AcpLaunchConfig {
  label: string;
  supportsExternalModelSelection: boolean;
  prepareSpawn(model?: string): Promise<{ args: string[]; env: Record<string, string> }>;
}

export function createAcpLaunchConfig(parsed: ParsedCommand, log: (message: string) => void): AcpLaunchConfig {
  const commandLabel = path.basename(parsed.command);

  if (commandLabel === 'pi-acp' || commandLabel === 'pi-acp.cmd') {
    return {
      label: 'pi-acp',
      supportsExternalModelSelection: true,
      async prepareSpawn(model?: string) {
        const env = { ...process.env } as Record<string, string>;
        if (model) {
          env.PI_ACP_PI_COMMAND = await writePiModelWrapper(model, log);
        }
        return { args: [...parsed.args], env };
      }
    };
  }

  if (commandLabel === 'kiro-cli' || commandLabel === 'kiro-cli.cmd' || commandLabel === 'kiro-cli.exe') {
    return {
      label: 'kiro-cli (acp)',
      supportsExternalModelSelection: true,
      async prepareSpawn(model?: string) {
        const args = [...parsed.args];
        if (!args.includes('acp')) {
          args.push('acp');
        }
        if (model) {
          args.push('--model', model);
        }
        return { args, env: { ...process.env } as Record<string, string> };
      }
    };
  }

  return {
    label: `${commandLabel} (acp)`,
    supportsExternalModelSelection: false,
    async prepareSpawn() {
      return { args: [...parsed.args], env: { ...process.env } as Record<string, string> };
    }
  };
}

async function writePiModelWrapper(model: string, log: (message: string) => void): Promise<string> {
  const isWin = platform() === 'win32';
  const ext = isWin ? '.cmd' : '.sh';
  const wrapperDir = path.join(os.tmpdir(), 'cicerone');

  await fs.promises.mkdir(wrapperDir, { recursive: true });

  const safeName = model.replace(/[^a-zA-Z0-9_-]/g, '_');
  const wrapperPath = path.join(wrapperDir, `pi-model-${safeName}${ext}`);

  if (!isWin) {
    const basePiCommand = process.env.PI_ACP_PI_COMMAND || 'pi';
    const script = `#!/bin/sh
exec ${basePiCommand} --model "${model}" "$@"
`;
    await fs.promises.writeFile(wrapperPath, script, { mode: 0o755 });
  } else {
    const basePiCommand = process.env.PI_ACP_PI_COMMAND || 'pi.cmd';
    const script = `@echo off
${basePiCommand} --model "${model}" %*
`;
    await fs.promises.writeFile(wrapperPath, script);
  }

  log(`[AcpBackend] wrote model wrapper: ${wrapperPath}`);
  return wrapperPath;
}
