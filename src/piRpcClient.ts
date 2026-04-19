import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { buildTourPrompt, parseTourResponse } from './backend/tourPrompt';
import { TourBackendResponse } from './backend/types';

type RpcEvent = {
  type?: string;
  success?: boolean;
  error?: string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
};

export class PiRpcClient {
  constructor(private readonly log: (message: string) => void = () => undefined) {}

  async generateTour(question: string, cwd: string, activeFile?: string, selectedText?: string): Promise<TourBackendResponse> {
    const prompt = buildTourPrompt(question, cwd, activeFile, selectedText);
    this.log(`[PiRpcClient] Starting pi request`);
    this.log(`[PiRpcClient] cwd=${cwd}`);
    this.log(`[PiRpcClient] activeFile=${activeFile ?? '<none>'}`);
    this.log(`[PiRpcClient] question=${question}`);

    return await new Promise<TourBackendResponse>((resolve, reject) => {
      const command = ['pi', '--mode', 'rpc', '--no-session'];
      this.log(`[PiRpcClient] spawn=${command.join(' ')}`);

      const child = spawn(command[0], command.slice(1), {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdoutBuffer = '';
      let answerBuffer = '';
      let stderrBuffer = '';
      let responseAccepted = false;
      let settled = false;
      const decoder = new StringDecoder('utf8');

      const finish = (fn: () => void): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (!child.stdin.destroyed) {
          child.stdin.end();
        }
        child.kill();
        fn();
      };

      child.on('error', (error) => {
        this.log(`[PiRpcClient] process error: ${error.message}`);
        finish(() => reject(new Error(`Failed to start pi: ${error.message}`)));
      });

      child.stderr.on('data', (chunk: Buffer | string) => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        stderrBuffer += text;
        this.log(`[pi stderr] ${text.trimEnd()}`);
      });

      child.stdout.on('data', (chunk: Buffer | string) => {
        stdoutBuffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);

        while (true) {
          const newlineIndex = stdoutBuffer.indexOf('\n');
          if (newlineIndex === -1) {
            break;
          }

          let line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) {
            line = line.slice(0, -1);
          }
          if (!line.trim()) {
            continue;
          }

          try {
            const event = JSON.parse(line) as RpcEvent;
            this.log(`[pi stdout event] ${line}`);

            if (event.type === 'response' && event.success === false) {
              this.log(`[PiRpcClient] prompt rejected: ${event.error || 'unknown error'}`);
              finish(() => reject(new Error(event.error || 'pi rejected the prompt request.')));
              return;
            }

            if (event.type === 'response' && event.success === true) {
              responseAccepted = true;
              this.log('[PiRpcClient] prompt accepted');
            }

            if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
              answerBuffer += event.assistantMessageEvent.delta || '';
            }

            if (event.type === 'agent_end') {
              this.log(`[PiRpcClient] agent_end received; answer length=${answerBuffer.length}`);
              finish(() => {
                try {
                  this.log(`[PiRpcClient] parsing response length=${answerBuffer.trim().length}`);
                  const response = parseTourResponse(answerBuffer, cwd);
                  this.log(`[PiRpcClient] parsed topic="${response.topic}" steps=${response.steps.length}`);
                  resolve(response);
                } catch (error) {
                  reject(error instanceof Error ? error : new Error(String(error)));
                }
              });
              return;
            }
          } catch (error) {
            this.log(`[PiRpcClient] failed to parse stdout line: ${String(error)}`);
            finish(() => reject(new Error(`Failed to parse pi RPC output: ${String(error)}`)));
            return;
          }
        }
      });

      child.on('close', (code) => {
        this.log(`[PiRpcClient] process closed with code=${code ?? 'unknown'}`);
        if (settled) {
          return;
        }

        finish(() => {
          if (!responseAccepted) {
            this.log('[PiRpcClient] pi exited before prompt acceptance');
            reject(new Error(stderrBuffer.trim() || `pi exited before accepting the prompt (code ${code ?? 'unknown'}).`));
            return;
          }

          try {
            this.log(`[PiRpcClient] parsing response length=${answerBuffer.trim().length}`);
            const response = parseTourResponse(answerBuffer, cwd);
            this.log(`[PiRpcClient] parsed topic="${response.topic}" steps=${response.steps.length}`);
            resolve(response);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      });

      const payload = JSON.stringify({ type: 'prompt', message: prompt });
      this.log(`[PiRpcClient] sending prompt payload bytes=${payload.length}`);
      child.stdin.write(`${payload}\n`);
    });
  }

}
