import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { platform } from 'os';
import { StringDecoder } from 'string_decoder';
import * as path from 'path';
import { parseCommand } from './acp/command';
import { createAcpLaunchConfig } from './acp/vendorLaunch';
import { buildTourPrompt, parseTourResponse } from './tourPrompt';
import { TourBackend, TourBackendRequest, TourBackendResponse, TourBackendSession } from './types';

interface JsonRpcEnvelope {
  id?: number;
  method?: string;
  result?: unknown;
  error?: {
    message?: string;
    data?: unknown;
  };
  params?: {
    sessionId?: string;
    update?: {
      sessionUpdate?: string;
      content?: {
        type?: string;
        text?: string;
      };
    };
  };
}

export class AcpBackend implements TourBackend {
  private readonly command: string;
  private readonly launchConfig: ReturnType<typeof createAcpLaunchConfig>;

  constructor(private readonly log: (message: string) => void = () => undefined, command?: string, private readonly model?: string) {
    this.command = command || (platform() === 'win32' ? 'pi-acp.cmd' : 'pi-acp');
    this.launchConfig = createAcpLaunchConfig(parseCommand(this.command), this.log);
  }

  getLabel(): string {
    return this.launchConfig.label;
  }

  supportsExternalModelSelection(): boolean {
    return this.launchConfig.supportsExternalModelSelection;
  }

  async createSession(cwd: string): Promise<TourBackendSession> {
    return await AcpBackendSession.create(
      cwd,
      this.command,
      this.log,
      this.supportsExternalModelSelection() ? this.model : undefined
    );
  }
}

class AcpBackendSession implements TourBackendSession {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly updates: JsonRpcEnvelope[] = [];
  private readonly updateWaiters: Array<(event: JsonRpcEnvelope) => void> = [];
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private nextId = 1;
  private disposed = false;
  private busy = false;

  private constructor(
    private readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly sessionId: string,
    private readonly log: (message: string) => void
  ) {
    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      this.drainStdout();
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.log(`[acp stderr] ${text.trimEnd()}`);
    });

    this.child.on('error', error => {
      this.failAll(new Error(`ACP process error: ${error.message}`));
    });

    this.child.on('close', code => {
      if (!this.disposed) {
        this.failAll(new Error(`ACP process exited unexpectedly (code ${code ?? 'unknown'}).`));
      }
    });
  }

  static async create(cwd: string, rawCommand: string, log: (message: string) => void, model?: string): Promise<AcpBackendSession> {
    const parsed = parseCommand(rawCommand);
    const launchConfig = createAcpLaunchConfig(parsed, log);
    const { args, env } = await launchConfig.prepareSpawn(model);

    log(`[AcpBackend] spawn=${parsed.command} ${args.join(' ')} cwd=${cwd}`);

    const child = spawn(parsed.command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: platform() === 'win32',
      env
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });

    const bootstrap = new AcpBootstrap(child, log);
    const sessionId = await bootstrap.initialize(cwd);
    bootstrap.dispose();
    return new AcpBackendSession(cwd, child, sessionId, log);
  }

  async generateTour(request: TourBackendRequest): Promise<TourBackendResponse> {
    if (this.disposed) {
      throw new Error('ACP session has been disposed.');
    }
    if (this.busy) {
      throw new Error('ACP session is busy.');
    }

    this.busy = true;
    const prompt = buildTourPrompt(request.question, request.cwd, request.activeFile, request.selectedText, request.activeStep);
    let answerBuffer = '';

    try {
      this.log(`[AcpBackend] prompt question=${request.question}`);
      await this.requestRpc('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: prompt }]
      });

      while (this.updates.length > 0) {
        const event = this.updates.shift()!;
        const update = event.params?.update;
        if (event.params?.sessionId === this.sessionId && update?.sessionUpdate === 'agent_message_chunk') {
          if (update.content?.type === 'text') {
            answerBuffer += update.content.text || '';
          }
        }
      }

      this.log(`[AcpBackend] parsing response length=${answerBuffer.trim().length}`);
      const response = parseTourResponse(answerBuffer, request.cwd, this.log);
      this.log(`[AcpBackend] parsed topic="${response.topic}" steps=${response.steps.length}`);
      return response;
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.child.kill();
    this.failAll(new Error('ACP session disposed.'));
  }

  private requestRpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.log(`[AcpBackend] -> ${payload}`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`, error => {
        if (error) {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }).then((result) => {
      if (method === 'session/prompt') {
        this.busy = false;
      }
      return result;
    });
  }

  private nextUpdate(): Promise<JsonRpcEnvelope> {
    const queued = this.updates.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise(resolve => {
      this.updateWaiters.push(resolve);
    });
  }

  private emitUpdate(message: JsonRpcEnvelope): void {
    const waiter = this.updateWaiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }

    this.updates.push(message);
  }

  private drainStdout(): void {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      if (!line.trim()) {
        continue;
      }

      this.log(`[acp stdout] ${line}`);
      let message: JsonRpcEnvelope;
      try {
        message = JSON.parse(line) as JsonRpcEnvelope;
      } catch (error) {
        this.failAll(new Error(`Failed to parse ACP output: ${String(error)}`));
        return;
      }

      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(message.error.message || JSON.stringify(message.error.data) || 'Unknown ACP error'));
        } else {
          waiter.resolve(message.result);
        }
        continue;
      }

      if (message.method === 'session/update') {
        this.emitUpdate(message);
      }
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();

    while (this.updateWaiters.length) {
      const waiter = this.updateWaiters.shift();
      waiter?.({ id: -1, error: { message: error.message } });
    }
  }
}

class AcpBootstrap {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private nextId = 1;
  private readonly onData = (chunk: Buffer | string): void => {
      this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      while (true) {
        const newlineIndex = this.stdoutBuffer.indexOf('\n');
        if (newlineIndex === -1) break;
        let line = this.stdoutBuffer.slice(0, newlineIndex);
        this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line.trim()) continue;
        this.log(`[acp stdout] ${line}`);
        try {
          const message = JSON.parse(line) as JsonRpcEnvelope;
          if (typeof message.id === 'number' && this.pending.has(message.id)) {
            const waiter = this.pending.get(message.id)!;
            this.pending.delete(message.id);
            if (message.error) waiter.reject(new Error(message.error.message || 'Unknown ACP error'));
            else waiter.resolve(message.result);
          }
        } catch (error) {
          for (const waiter of this.pending.values()) waiter.reject(new Error(String(error)));
          this.pending.clear();
        }
      }
    };

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly log: (message: string) => void) {
    this.child.stdout.on('data', this.onData);
  }

  dispose(): void {
    this.child.stdout.off('data', this.onData);
  }

  async initialize(cwd: string): Promise<string> {
    await this.requestRpc('initialize', { protocolVersion: 1 });
    const result = (await this.requestRpc('session/new', { cwd, mcpServers: [] })) as { sessionId?: string };
    if (!result.sessionId) {
      throw new Error('pi-acp did not return a sessionId.');
    }
    return result.sessionId;
  }

  private requestRpc(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    this.log(`[AcpBackend] -> ${payload}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${payload}\n`, error => {
        if (error) {
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }
}

