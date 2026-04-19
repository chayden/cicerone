import { platform } from 'os';

export interface ParsedCommand {
  command: string;
  args: string[];
}

export function parseCommand(value: string): ParsedCommand {
  const parts = Array.from(value.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)).map(match => match[1] ?? match[2] ?? match[3]);
  if (parts.length === 0) {
    return { command: platform() === 'win32' ? 'pi-acp.cmd' : 'pi-acp', args: [] };
  }

  const [command, ...args] = parts;
  return { command, args };
}
