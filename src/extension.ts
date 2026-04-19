import * as path from 'path';
import * as vscode from 'vscode';
import { AcpBackend } from './backend/acpBackend';
import { PiRpcBackend } from './backend/piRpcBackend';
import { resolveStepLocations } from './backend/lineResolver';
import { listAvailableModels, PiModelInfo } from './backend/modelList';
import { TourBackend, TourBackendSession } from './backend/types';
import { CommentTourController } from './commentTourController';
import { TourOutlineProvider } from './tourOutlineProvider';
import { TourStackManager } from './tourStackManager';
import { CiceroneStep } from './types';

const tourStack = new TourStackManager();
const commentController = new CommentTourController();
const outputChannel = vscode.window.createOutputChannel('Cicerone');
const DEFAULT_PI_MODEL = 'google-antigravity/gemini-3-flash';
const DEFAULT_KIRO_MODEL = 'claude-haiku-4.5';

let backend: TourBackend;
let backendSession: TourBackendSession | undefined;
let backendLabel = 'pi-acp';
let sidebarQuestionDraft = '';
let isTourVisible = true;
let currentModelSetting = '';
let currentBackendChoice = 'pi-acp';
let availableModels: PiModelInfo[] = [];
let supportsModelSelection = true;
let workspaceState: vscode.Memento;
let tourOutlineProvider: TourOutlineProvider;

export function activate(context: vscode.ExtensionContext): void {
  workspaceState = context.workspaceState;
  sidebarQuestionDraft = workspaceState.get<string>('cicerone.sidebarQuestionDraft', '');
  context.subscriptions.push(commentController, outputChannel);
  outputChannel.appendLine('[Cicerone] Extension activated');
  backend = createBackend();
  tourOutlineProvider = new TourOutlineProvider();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(TourOutlineProvider.viewType, tourOutlineProvider));

  // Fetch available models in the background
  refreshAvailableModels();

  context.subscriptions.push(
    vscode.commands.registerCommand('cicerone.askTour', async () => {
      const question = await vscode.window.showInputBox({
        prompt: 'Ask a question about the codebase',
        placeHolder: 'How does tour state flow through the extension?'
      });

      if (!question?.trim()) {
        return;
      }

      await setSidebarQuestionDraft(question.trim());
      await startTour(question.trim(), { reuseSession: false });
    }),

    vscode.commands.registerCommand('cicerone.askTourWithQuestion', async (question: string) => {
      if (!question?.trim()) {
        return;
      }

      setSidebarQuestionDraft(question.trim());
      await startTour(question.trim(), { reuseSession: false });
    }),

    vscode.commands.registerCommand('cicerone.setSidebarQuestionDraft', async (question: string) => {
      sidebarQuestionDraft = question;
      await workspaceState.update('cicerone.sidebarQuestionDraft', question);
    }),

    vscode.commands.registerCommand('cicerone.setBackendChoice', async (choice: string) => {
      const configuration = vscode.workspace.getConfiguration('cicerone');

      if (choice === 'pi-rpc') {
        await configuration.update('backend', 'pi-rpc', vscode.ConfigurationTarget.Global);
      } else if (choice === 'kiro-cli') {
        await configuration.update('backend', 'acp', vscode.ConfigurationTarget.Global);
        await configuration.update('acpCommand', 'kiro-cli acp', vscode.ConfigurationTarget.Global);

        const configuredModel = configuration.get<string>('model', DEFAULT_PI_MODEL).trim();
        if (!configuredModel || configuredModel === DEFAULT_PI_MODEL) {
          await configuration.update('model', DEFAULT_KIRO_MODEL, vscode.ConfigurationTarget.Global);
        }
      } else {
        await configuration.update('backend', 'acp', vscode.ConfigurationTarget.Global);
        await configuration.update('acpCommand', 'pi-acp', vscode.ConfigurationTarget.Global);
      }

      await disposeBackendSession();
      backend = createBackend();
      await refreshAvailableModels();
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.setModel', async (model: string) => {
      if (!supportsModelSelection) {
        vscode.window.showInformationMessage('Model selection is only available for pi-backed sessions.');
        return;
      }

      const configuration = vscode.workspace.getConfiguration('cicerone');
      await configuration.update('model', model, vscode.ConfigurationTarget.Global);
      currentModelSetting = model;
      outputChannel.appendLine(`[Cicerone] Model changed to ${model}. Will take effect on next session.`);
      await disposeBackendSession();
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.toggleTourVisibility', () => {
      isTourVisible = !isTourVisible;
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.replyInTour', async (reply: vscode.CommentReply) => {
      const question = reply.text.trim();
      if (!question) {
        vscode.window.showWarningMessage('Enter a follow-up question in the comment box first.');
        return;
      }

      const workspaceRoot = getWorkspaceRoot(reply.thread.uri) || getWorkspaceRoot(vscode.window.activeTextEditor?.document.uri);
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('Could not determine a workspace root for the follow-up question.');
        return;
      }

      try {
        outputChannel.appendLine(`[Cicerone] replyInTour question=${question}`);
        const rawResponse = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Cicerone is asking ${backendLabel} for a tangent tour…`,
            cancellable: false
          },
          async () => {
            const session = await getBackendSession(workspaceRoot, true);
            const activeStep = tourStack.getActiveStep();
            return await session.generateTour({
              question,
              cwd: workspaceRoot,
              activeFile: reply.thread.uri.fsPath,
              activeStep: activeStep ? {
                file: activeStep.file,
                line: activeStep.line,
                title: activeStep.title,
                explanation: activeStep.explanation
              } : undefined
            });
          }
        );

        const response = { ...rawResponse, steps: resolveStepLocations(rawResponse.steps, workspaceRoot) };

        const activeTour = tourStack.getActiveTour();
        const tour = activeTour
          ? tourStack.startTangent(response.topic, response.steps, {
              question,
              answerSummary: response.answerSummary
            })
          : tourStack.initializeTour(response.topic, response.steps, {
              question,
              answerSummary: response.answerSummary
            });

        await renderActiveStep(tour.steps[tour.currentStepIndex]);
        syncTourOutline();
        vscode.window.showInformationMessage(`Started Cicerone tangent: ${tour.topic}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[Cicerone] replyInTour error=${message}`);
        outputChannel.show(true);
        vscode.window.showErrorMessage(`Cicerone could not generate a tangent tour: ${message}`);
      }
    }),

    vscode.commands.registerCommand('cicerone.goToStep', async (index: number) => {
      const step = tourStack.moveToStep(index);
      if (!step) {
        return;
      }

      await renderActiveStep(step);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.activateTourAt', async (index: number) => {
      const tour = tourStack.activateTourAt(index);
      if (!tour) {
        return;
      }

      await renderActiveStep(tour.steps[tour.currentStepIndex]);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.toggleAnnotationMode', async () => {
      const tour = tourStack.toggleAnnotationMode();
      if (!tour) {
        return;
      }

      await renderActiveStep(tourStack.getActiveStep());
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.nextStep', async () => {
      const step = tourStack.nextStep();
      if (!step) {
        vscode.window.showInformationMessage('No next step in the active tour.');
        return;
      }

      await renderActiveStep(step);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.previousStep', async () => {
      const step = tourStack.previousStep();
      if (!step) {
        vscode.window.showInformationMessage('No previous step in the active tour.');
        return;
      }

      await renderActiveStep(step);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.nextTour', async () => {
      const tour = tourStack.nextTour();
      if (!tour) {
        vscode.window.showInformationMessage('No other tour in the stack.');
        return;
      }

      await renderActiveStep(tour.steps[tour.currentStepIndex]);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.previousTour', async () => {
      const tour = tourStack.previousTour();
      if (!tour) {
        vscode.window.showInformationMessage('No other tour in the stack.');
        return;
      }

      await renderActiveStep(tour.steps[tour.currentStepIndex]);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.discardTourAt', async (index: number) => {
      const result = tourStack.discardTourAt(index);
      if (!result) {
        return;
      }

      if (!result.activeTour) {
        await disposeBackendSession();
        commentController.clear();
        syncTourOutline();
        vscode.window.showInformationMessage('Cicerone tour discarded.');
        return;
      }

      syncTourOutline();
      await renderActiveStep(result.activeTour.steps[result.activeTour.currentStepIndex]);
    }),

    vscode.commands.registerCommand('cicerone.discardCurrentTour', async () => {
      const activeIndex = tourStack.getStackDepth() - 1;
      if (activeIndex >= 0) {
        await vscode.commands.executeCommand('cicerone.discardTourAt', activeIndex);
      }
    }),

    vscode.commands.registerCommand('cicerone.exitTour', async () => {
      tourStack.concludeJourney();
      const activeTour = tourStack.getActiveTour();

      if (!activeTour) {
        await disposeBackendSession();
        commentController.clear();
        syncTourOutline();
        vscode.window.showInformationMessage('Cicerone tour ended.');
        return;
      }

      syncTourOutline();
      await renderActiveStep(tourStack.getActiveStep());
    })
  );
}

export async function deactivate(): Promise<void> {
  await disposeBackendSession();
  commentController.dispose();
}

async function renderActiveStep(step: CiceroneStep | undefined): Promise<void> {
  const activeTour = tourStack.getActiveTour();
  if (!step || !activeTour) {
    commentController.clear();
    return;
  }

  await commentController.renderStep(activeTour, step);
}

function getWorkspaceRoot(uri?: vscode.Uri): string | undefined {
  if (uri) {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) {
      return folder.uri.fsPath;
    }

    return path.dirname(uri.fsPath);
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function syncTourOutline(): void {
  tourOutlineProvider.setState(
    tourStack.getActiveTour(),
    tourStack.getTours(),
    backendLabel,
    sidebarQuestionDraft,
    backendSession !== undefined,
    supportsModelSelection ? currentModelSetting : '',
    supportsModelSelection ? availableModels : [],
    isTourVisible,
    currentBackendChoice
  );
}

function createBackend(): TourBackend {
  const configuration = vscode.workspace.getConfiguration('cicerone');
  const backendName = configuration.get<string>('backend', 'acp');
  const configuredModel = configuration.get<string>('model', DEFAULT_PI_MODEL).trim();
  const acpCommand = configuration.get<string>('acpCommand', '').trim()
    || configuration.get<string>('piAcpCommand', '').trim();
  const inferredBackendChoice = backendName === 'pi-rpc'
    ? 'pi-rpc'
    : /(^|\s|\/)kiro-cli(?:$|\s)/.test(acpCommand || '')
    ? 'kiro-cli'
    : 'pi-acp';
  const model = configuredModel || (inferredBackendChoice === 'kiro-cli' ? DEFAULT_KIRO_MODEL : DEFAULT_PI_MODEL);
  currentModelSetting = model;
  const log = (message: string): void => outputChannel.appendLine(message);

  if (backendName === 'pi-rpc') {
    supportsModelSelection = true;
    currentBackendChoice = 'pi-rpc';
    backendLabel = 'pi-rpc';
    outputChannel.appendLine(`[Cicerone] Using backend=pi-rpc model=${model}`);
    return new PiRpcBackend(log, model || undefined);
  }

  const acpBackend = new AcpBackend(log, acpCommand || undefined, model || undefined);
  supportsModelSelection = acpBackend.supportsExternalModelSelection();
  currentBackendChoice = inferredBackendChoice;
  backendLabel = acpBackend.getLabel();
  outputChannel.appendLine(
    `[Cicerone] Using backend=acp command=${acpCommand || 'pi-acp'}${supportsModelSelection ? ` model=${model}` : ''}`
  );
  return acpBackend;
}

async function startTour(question: string, options: { reuseSession: boolean }): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const workspaceRoot = getWorkspaceRoot(editor?.document.uri);
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder or file before asking Cicerone a question.');
    return;
  }

  try {
    outputChannel.appendLine(`[Cicerone] askTour question=${question}`);
    const rawResponse = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Cicerone is asking ${backendLabel} for a code tour…`,
        cancellable: false
      },
      async () => {
        const session = await getBackendSession(workspaceRoot, options.reuseSession);
        return await session.generateTour({
          question,
          cwd: workspaceRoot,
          activeFile: editor?.document.uri.fsPath,
          selectedText:
            editor?.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection).slice(0, 4000) : undefined
        });
      }
    );

    const response = { ...rawResponse, steps: resolveStepLocations(rawResponse.steps, workspaceRoot) };

    const tour = tourStack.initializeTour(response.topic, response.steps, {
      question,
      answerSummary: response.answerSummary
    });

    await renderActiveStep(tourStack.getActiveStep());
    syncTourOutline();
    vscode.window.showInformationMessage(`Started Cicerone tour: ${tour.topic}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`[Cicerone] askTour error=${message}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`Cicerone could not generate a ${backendLabel} tour: ${message}`);
  }
}

async function getBackendSession(cwd: string, reuseExisting: boolean): Promise<TourBackendSession> {
  if (!reuseExisting && backendSession) {
    await disposeBackendSession();
  }

  if (!backendSession) {
    backendSession = await backend.createSession(cwd);
  }

  return backendSession;
}

async function disposeBackendSession(): Promise<void> {
  if (!backendSession) {
    return;
  }

  await backendSession.dispose();
  backendSession = undefined;
}

async function setSidebarQuestionDraft(question: string): Promise<void> {
  sidebarQuestionDraft = question;
  await workspaceState.update('cicerone.sidebarQuestionDraft', question);
}

async function refreshAvailableModels(): Promise<void> {
  if (!supportsModelSelection) {
    availableModels = [];
    syncTourOutline();
    return;
  }

  availableModels = await listAvailableModels(currentBackendChoice);
  if (availableModels.length > 0) {
    outputChannel.appendLine(`[Cicerone] Available models: ${availableModels.map(m => m.fullName).join(', ')}`);
  } else {
    outputChannel.appendLine('[Cicerone] Could not detect available models (pi may not be installed).');
  }
  syncTourOutline();
}
