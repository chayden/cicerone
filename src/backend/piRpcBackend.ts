import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { buildTourPrompt, parseTourResponse } from './tourPrompt';
import { TourBackend, TourBackendRequest, TourBackendResponse, TourBackendSession } from './types';

interface RpcEvent {
  type?: string;
  success?: boolean;
  error?: string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
}

export class PiRpcBackend implements TourBackend {
  constructor(private readonly log: (message: string) => void = () => undefined, private readonly model?: string) {}

  async createSession(cwd: string): Promise<TourBackendSession> {
    return await PiRpcBackendSession.create(cwd, this.log, this.model);
  }
}

class PiRpcBackendSession implements TourBackendSession {
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private readonly eventQueue: RpcEvent[] = [];
  private readonly waiters: Array<(event: RpcEvent) => void> = [];
  private readonly decoder = new StringDecoder('utf8');
  private stdoutBuffer = '';
  private disposed = false;
  private busy = false;

  private constructor(
    private readonly cwd: string,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly log: (message: string) => void
  ) {
    this.child.stdout.on('data', (chunk: Buffer | string) => {
      this.stdoutBuffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
      this.drainStdout();
    });

    this.child.stderr.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      this.log(`[pi stderr] ${text.trimEnd()}`);
    });

    this.child.on('error', error => {
      this.failAll(new Error(`pi RPC process error: ${error.message}`));
    });

    this.child.on('close', code => {
      if (!this.disposed) {
        this.failAll(new Error(`pi RPC exited unexpectedly (code ${code ?? 'unknown'}).`));
      }
    });
  }

  static async create(cwd: string, log: (message: string) => void, model?: string): Promise<PiRpcBackendSession> {
    const spawnArgs = ['--mode', 'rpc', '--no-session'];
    if (model) {
      spawnArgs.push('--model', model);
    }

    log(`[PiRpcBackend] spawn=pi ${spawnArgs.join(' ')} cwd=${cwd}`);
    const child = spawn('pi', spawnArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', reject);
    });

    return new PiRpcBackendSession(cwd, child, log);
  }

  async generateTour(request: TourBackendRequest): Promise<TourBackendResponse> {
    if (this.disposed) {
      throw new Error('pi RPC session has been disposed.');
    }
    if (this.busy) {
      throw new Error('pi RPC session is busy.');
    }

    this.busy = true;
    const prompt = buildTourPrompt(request.question, request.cwd, request.activeFile, request.selectedText, request.activeStep);
    let answerBuffer = '';
    const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      this.log(`[PiRpcBackend] prompt question=${request.question}`);
      const accepted = this.waitForResponse(id);
      this.child.stdin.write(`${JSON.stringify({ id, type: 'prompt', message: prompt })}\n`);
      await accepted;

      while (true) {
        const event = await this.nextEvent();
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          answerBuffer += event.assistantMessageEvent.delta || '';
        }
        if (event.type === 'agent_end') {
          break;
        }
      }

      this.log(`[PiRpcBackend] parsing response length=${answerBuffer.trim().length}`);
      const response = parseTourResponse(answerBuffer, request.cwd, this.log);
      this.log(`[PiRpcBackend] parsed topic="${response.topic}" steps=${response.steps.length}`);
      return response;
    } finally {
      this.busy = false;
    }
  }

  async generateText(prompt: string): Promise<string> {
    if (this.disposed) {
      throw new Error('pi RPC session has been disposed.');
    }
    if (this.busy) {
      throw new Error('pi RPC session is busy.');
    }

    this.busy = true;
    let answerBuffer = '';
    const id = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      this.log(`[PiRpcBackend] generateText prompt length=${prompt.length}`);
      const accepted = this.waitForResponse(id);
      this.child.stdin.write(`${JSON.stringify({ id, type: 'prompt', message: prompt })}\n`);
      await accepted;

      while (true) {
        const event = await this.nextEvent();
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
          answerBuffer += event.assistantMessageEvent.delta || '';
        }
        if (event.type === 'agent_end') {
          break;
        }
      }

      return answerBuffer.trim();
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
    this.failAll(new Error('pi RPC session disposed.'));
  }

  private waitForResponse(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private nextEvent(): Promise<RpcEvent> {
    const queued = this.eventQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise(resolve => {
      this.waiters.push(resolve);
    });
  }

  private emitEvent(event: RpcEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
      return;
    }

    this.eventQueue.push(event);
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

      this.log(`[pi stdout event] ${line}`);
      let event: RpcEvent;
      try {
        event = JSON.parse(line) as RpcEvent;
      } catch (error) {
        this.failAll(new Error(`Failed to parse pi RPC output: ${String(error)}`));
        return;
      }

      if (typeof event.type === 'string' && event.type === 'response') {
        const parsed = JSON.parse(line) as RpcEvent & { id?: string };
        if (parsed.id && this.pending.has(parsed.id)) {
          const waiter = this.pending.get(parsed.id)!;
          this.pending.delete(parsed.id);
          if (parsed.success === false) {
            waiter.reject(new Error(parsed.error || 'pi rejected the prompt request.'));
          } else {
            waiter.resolve();
          }
          continue;
        }
      }

      this.emitEvent(event);
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();

    while (this.waiters.length) {
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter({ type: 'agent_end', success: false, error: error.message });
      }
    }
  }
}
