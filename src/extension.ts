import * as path from 'path';
import * as vscode from 'vscode';
import { AcpBackend } from './backend/acpBackend';
import { PiRpcBackend } from './backend/piRpcBackend';
import { resolveStepLocations } from './backend/lineResolver';
import { listAvailableModels, ModelInfo } from './backend/modelList';
import { TourBackend, TourBackendSession } from './backend/types';
import { CommentTourController } from './commentTourController';
import { TourOutlineProvider } from './tourOutlineProvider';
import { TourStackManager } from './tourStackManager';
import { CiceroneSavedNoteContext, CiceroneStep } from './types';

const tourStack = new TourStackManager();
const commentController = new CommentTourController();
const outputChannel = vscode.window.createOutputChannel('Cicerone');
const DEFAULT_PI_MODEL = 'google-antigravity/gemini-3-flash';
const DEFAULT_KIRO_MODEL = 'claude-haiku-4.5';

let backend: TourBackend;
const backendSessions = new Map<string, TourBackendSession>();
let backendLabel = 'pi-acp';
let sidebarQuestionDraft = '';
let sidebarNotes = '';
let sidebarSummary = '';
let isGeneratingSummary = false;
let isTourVisible = true;
let currentModelSetting = '';
let currentBackendChoice = 'pi-acp';
let availableModels: ModelInfo[] = [];
let supportsModelSelection = true;
let workspaceState: vscode.Memento;
let tourOutlineProvider: TourOutlineProvider;
let modelRefreshRequestId = 0;

export function activate(context: vscode.ExtensionContext): void {
  workspaceState = context.workspaceState;
  sidebarQuestionDraft = workspaceState.get<string>('cicerone.sidebarQuestionDraft', '');
  sidebarNotes = workspaceState.get<string>('cicerone.sidebarNotes', '');
  sidebarSummary = workspaceState.get<string>('cicerone.sidebarSummary', '');
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

      await setSidebarQuestionDraft('');
      syncTourOutline();
      void startTour(question.trim(), { reuseSession: false });
    }),

    vscode.commands.registerCommand('cicerone.askTourWithQuestion', async (question: string) => {
      if (!question?.trim()) {
        return;
      }

      await setSidebarQuestionDraft('');
      syncTourOutline();
      void startTour(question.trim(), { reuseSession: false });
    }),

    vscode.commands.registerCommand('cicerone.setSidebarQuestionDraft', async (question: string) => {
      sidebarQuestionDraft = question;
      await workspaceState.update('cicerone.sidebarQuestionDraft', question);
    }),

    vscode.commands.registerCommand('cicerone.setSidebarNotes', async (notes: string) => {
      sidebarNotes = notes;
      await workspaceState.update('cicerone.sidebarNotes', notes);
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.setReplyModeTangent', async (threadKey: string) => {
      commentController.setReplyMode(threadKey, 'tangent');
      await renderActiveStep(tourStack.getActiveStep());
    }),

    vscode.commands.registerCommand('cicerone.setReplyModeNote', async (threadKey: string) => {
      commentController.setReplyMode(threadKey, 'note');
      await renderActiveStep(tourStack.getActiveStep());
    }),

    vscode.commands.registerCommand('cicerone.setReplyModeHidden', async (threadKey: string) => {
      commentController.setReplyMode(threadKey, 'hidden');
      await renderActiveStep(tourStack.getActiveStep());
    }),

    vscode.commands.registerCommand('cicerone.copyTourNotes', async () => {
      await vscode.env.clipboard.writeText(sidebarNotes);
      vscode.window.showInformationMessage(sidebarNotes.trim() ? 'Cicerone notes copied.' : 'Cicerone notes are empty, but copied.');
    }),

    vscode.commands.registerCommand('cicerone.createSummary', async () => {
      if (tourStack.getStackDepth() === 0 && !sidebarNotes.trim()) {
        vscode.window.showInformationMessage('No active tours or notes to summarize.');
        return;
      }

      const activeTour = tourStack.getActiveTour();
      const workspaceRoot = activeTour
        ? getWorkspaceRoot(vscode.window.activeTextEditor?.document.uri)
        : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (!workspaceRoot) {
        vscode.window.showErrorMessage('Could not determine a workspace root to generate summary.');
        return;
      }

      isGeneratingSummary = true;
      syncTourOutline();

      try {
        const session = activeTour
          ? await getSessionForRootTourId(activeTour.rootTourId, workspaceRoot)
          : await backend.createSession(workspaceRoot); // Fallback one-off session if no active tour

        const formattedTours = tourStack.getTours().map((t, i) => {
          let str = `Tour ${i + 1}: ${t.topic}\n`;
          if (t.question) str += `Question: ${t.question}\n`;
          if (t.answerSummary) str += `Summary: ${t.answerSummary}\n`;
          t.steps.forEach((s, j) => {
            str += `  Step ${j + 1}: ${path.basename(s.file)}:${s.line} - ${s.title}\n`;
            str += `  ${s.explanation}\n`;
          });
          return str;
        }).join('\n\n');

        const prompt = `You are an expert developer assistant summarizing a codebase exploration session.
The user has taken a series of code tours and written some personal notes.

<user_notes>
${sidebarNotes || "(No notes provided)"}
</user_notes>

<tours>
${formattedTours || "(No tours provided)"}
</tours>

Create a clean, well-formatted Markdown summary of the key information learned during this session.
Make the user's personal notes VERY prominent in the summary, expanding on them using the context from the tours if appropriate.
Synthesize the tour steps into a cohesive overview rather than just listing them line-by-line.
Do not output JSON, just output the markdown summary directly.`;

        outputChannel.appendLine(`[Cicerone] createSummary requested`);
        const result = await session.generateText(prompt);

        if (!activeTour) {
          // Dispose the temporary fallback session
          await session.dispose();
        }

        sidebarSummary = result.trim();
        await workspaceState.update('cicerone.sidebarSummary', sidebarSummary);
        vscode.window.showInformationMessage('Cicerone summary generated successfully.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`[Cicerone] createSummary error=${message}`);
        vscode.window.showErrorMessage(`Cicerone could not generate summary: ${message}`);
      } finally {
        isGeneratingSummary = false;
        syncTourOutline();
      }
    }),

    vscode.commands.registerCommand('cicerone.setSidebarSummary', async (summary: string) => {
      sidebarSummary = summary;
      await workspaceState.update('cicerone.sidebarSummary', summary);
    }),

    vscode.commands.registerCommand('cicerone.clearSummary', async () => {
      sidebarSummary = '';
      await workspaceState.update('cicerone.sidebarSummary', '');
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.copySummary', async () => {
      await vscode.env.clipboard.writeText(sidebarSummary);
      vscode.window.showInformationMessage('Cicerone summary copied.');
    }),

    vscode.commands.registerCommand('cicerone.addTourNote', async (context: CiceroneSavedNoteContext) => {
      const entry = formatSavedNote(context);
      sidebarNotes = sidebarNotes.trim() ? `${sidebarNotes.trim()}\n\n${entry}` : entry;
      await workspaceState.update('cicerone.sidebarNotes', sidebarNotes);
      syncTourOutline();
      vscode.window.showInformationMessage('Added note to Cicerone sidebar notes.');
    }),

    vscode.commands.registerCommand('cicerone.setBackendChoice', async (choice: string) => {
      const configuration = vscode.workspace.getConfiguration('cicerone');
      const configuredModel = configuration.get<string>('model', '').trim();

      if (choice === 'pi-rpc') {
        await configuration.update('backend', 'pi-rpc', vscode.ConfigurationTarget.Global);
        if (!configuredModel || configuredModel === DEFAULT_KIRO_MODEL) {
          await configuration.update('model', DEFAULT_PI_MODEL, vscode.ConfigurationTarget.Global);
        }
      } else if (choice === 'kiro-cli') {
        await configuration.update('backend', 'acp', vscode.ConfigurationTarget.Global);
        await configuration.update('acpCommand', 'kiro-cli acp', vscode.ConfigurationTarget.Global);
        if (!configuredModel || configuredModel === DEFAULT_PI_MODEL) {
          await configuration.update('model', DEFAULT_KIRO_MODEL, vscode.ConfigurationTarget.Global);
        }
      } else {
        await configuration.update('backend', 'acp', vscode.ConfigurationTarget.Global);
        await configuration.update('acpCommand', 'pi-acp', vscode.ConfigurationTarget.Global);
        if (!configuredModel || configuredModel === DEFAULT_KIRO_MODEL) {
          await configuration.update('model', DEFAULT_PI_MODEL, vscode.ConfigurationTarget.Global);
        }
      }

      availableModels = [];
      await disposeAllBackendSessions();
      backend = createBackend();
      syncTourOutline();
      await refreshAvailableModels();
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.setModel', async (model: string) => {
      if (!supportsModelSelection) {
        vscode.window.showInformationMessage('Model selection is not available for the current backend.');
        return;
      }

      const configuration = vscode.workspace.getConfiguration('cicerone');
      await configuration.update('model', model, vscode.ConfigurationTarget.Global);
      currentModelSetting = model;
      outputChannel.appendLine(`[Cicerone] Model changed to ${model}. Will take effect on next session.`);
      await disposeAllBackendSessions();
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.toggleTourVisibility', async () => {
      isTourVisible = !isTourVisible;
      if (isTourVisible) {
        await renderActiveStep(tourStack.getActiveStep());
      } else {
        commentController.clear();
      }
      syncTourOutline();
    }),

    vscode.commands.registerCommand('cicerone.replyInTour', async (reply: vscode.CommentReply) => {
      const rawInput = reply.text.trim();
      if (!rawInput) {
        vscode.window.showWarningMessage('Enter a follow-up question or note in the comment box first.');
        return;
      }

      const activeStep = tourStack.getActiveStep();
      const activeTour = tourStack.getActiveTour();
      const threadKey = commentController.getThreadKeyFromReply(reply.thread);
      const replyMode = commentController.getReplyMode(threadKey);
      const noteContext = buildReplyNoteContext(reply, activeTour, activeStep);
      if (replyMode === 'note') {
        if (!noteContext) {
          vscode.window.showWarningMessage('No active tour step is available to attach a note.');
          return;
        }

        await vscode.commands.executeCommand('cicerone.addTourNote', {
          ...noteContext,
          userNote: rawInput
        } satisfies CiceroneSavedNoteContext);
        commentController.setReplyMode(threadKey, 'hidden');
        await renderActiveStep(tourStack.getActiveStep());
        return;
      }

      const question = rawInput;
      const workspaceRoot = getWorkspaceRoot(reply.thread.uri) || getWorkspaceRoot(vscode.window.activeTextEditor?.document.uri);
      if (!workspaceRoot) {
        vscode.window.showErrorMessage('Could not determine a workspace root for the follow-up question.');
        return;
      }

      try {
        outputChannel.appendLine(`[Cicerone] replyInTour question=${question}`);
        if (!activeTour) {
          throw new Error('No active tour is available to attach a tangent.');
        }

        const pendingTour = tourStack.createPendingTangent(question);
        if (!pendingTour) {
          throw new Error('Could not create pending tangent tour.');
        }
        const navigationVersion = tourStack.getInteractionVersion();
        syncTourOutline();

        const session = await getSessionForRootTourId(activeTour.rootTourId, workspaceRoot);
        const rawResponse = await session.generateTour({
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

        const response = { ...rawResponse, steps: resolveStepLocations(rawResponse.steps, message => outputChannel.appendLine(message)) };
        tourStack.completePendingTour(pendingTour.id, response.topic, response.steps, {
          question,
          answerSummary: response.answerSummary
        });

        commentController.setReplyMode(threadKey, 'hidden');
        syncTourOutline();
        if (tourStack.getInteractionVersion() === navigationVersion) {
          const tour = tourStack.activateTourById(pendingTour.id);
          if (tour) {
            await renderActiveStep(tour.steps[tour.currentStepIndex]);
            syncTourOutline();
          }
        }
        vscode.window.showInformationMessage(`Started Cicerone tangent: ${response.topic}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (activeTour) {
          const pending = tourStack.getTours().find(tour => tour.status === 'loading' && tour.parentTourId === activeTour.id && tour.question === question);
          if (pending) {
            tourStack.failPendingTour(pending.id, message);
            syncTourOutline();
          }
        }
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
        await disposeSessionFamily(result.discarded.rootTourId);
        commentController.clear();
        syncTourOutline();
        vscode.window.showInformationMessage('Cicerone tour discarded.');
        return;
      }

      syncTourOutline();
      await renderActiveStep(result.activeTour.steps[result.activeTour.currentStepIndex]);
    }),

    vscode.commands.registerCommand('cicerone.endTour', async () => {
      const previousTour = tourStack.getActiveTour();
      tourStack.concludeJourney();
      const activeTour = tourStack.getActiveTour();

      if (!activeTour) {
        if (previousTour) {
          await disposeSessionFamily(previousTour.rootTourId);
        }
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
  await disposeAllBackendSessions();
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
    sidebarNotes,
    sidebarSummary,
    isGeneratingSummary,
    backendSessions.size > 0,
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

async function startTour(question: string, _options: { reuseSession: boolean }): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const workspaceRoot = getWorkspaceRoot(editor?.document.uri);
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('Open a workspace folder or file before asking Cicerone a question.');
    return;
  }

  const pendingTour = tourStack.createPendingRoot(question);
  const navigationVersion = tourStack.getInteractionVersion();
  syncTourOutline();

  try {
    outputChannel.appendLine(`[Cicerone] askTour question=${question}`);
    const session = await createSessionForRootTourId(pendingTour.rootTourId, workspaceRoot);
    const rawResponse = await session.generateTour({
      question,
      cwd: workspaceRoot,
      activeFile: editor?.document.uri.fsPath,
      selectedText:
        editor?.selection && !editor.selection.isEmpty ? editor.document.getText(editor.selection).slice(0, 4000) : undefined
    });

    const response = { ...rawResponse, steps: resolveStepLocations(rawResponse.steps, message => outputChannel.appendLine(message)) };
    tourStack.completePendingTour(pendingTour.id, response.topic, response.steps, {
      question,
      answerSummary: response.answerSummary
    });

    syncTourOutline();
    if (tourStack.getInteractionVersion() === navigationVersion) {
      const tour = tourStack.activateTourById(pendingTour.id);
      if (tour) {
        await renderActiveStep(tour.steps[tour.currentStepIndex]);
        syncTourOutline();
      }
    }
    vscode.window.showInformationMessage(`Started Cicerone tour: ${response.topic}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tourStack.failPendingTour(pendingTour.id, message);
    await disposeSessionFamily(pendingTour.rootTourId);
    syncTourOutline();
    outputChannel.appendLine(`[Cicerone] askTour error=${message}`);
    outputChannel.show(true);
    vscode.window.showErrorMessage(`Cicerone could not generate a ${backendLabel} tour: ${message}`);
  }
}

async function createSessionForRootTourId(rootTourId: string, cwd: string): Promise<TourBackendSession> {
  const session = await backend.createSession(cwd);
  backendSessions.set(rootTourId, session);
  return session;
}

async function getSessionForRootTourId(rootTourId: string, cwd: string): Promise<TourBackendSession> {
  const existing = backendSessions.get(rootTourId);
  if (existing) {
    return existing;
  }

  return await createSessionForRootTourId(rootTourId, cwd);
}

async function disposeSessionFamily(rootTourId: string): Promise<void> {
  const session = backendSessions.get(rootTourId);
  if (!session) {
    return;
  }

  await session.dispose();
  backendSessions.delete(rootTourId);
}

async function disposeAllBackendSessions(): Promise<void> {
  const sessions = Array.from(backendSessions.values());
  backendSessions.clear();
  await Promise.allSettled(sessions.map(session => Promise.resolve(session.dispose())));
}

async function setSidebarQuestionDraft(question: string): Promise<void> {
  sidebarQuestionDraft = question;
  await workspaceState.update('cicerone.sidebarQuestionDraft', question);
}


function buildReplyNoteContext(
  reply: vscode.CommentReply,
  activeTour: { topic: string } | undefined,
  activeStep: CiceroneStep | undefined
): Omit<CiceroneSavedNoteContext, 'userNote'> | undefined {
  if (!activeTour || !activeStep) {
    return undefined;
  }

  const replyLine = reply.thread.range?.start.line !== undefined ? reply.thread.range.start.line + 1 : activeStep.line;
  const matchingHighlight = activeStep.extraHighlights?.find(highlight => highlight.line === replyLine);

  return {
    topic: activeTour.topic,
    file: reply.thread.uri.fsPath,
    line: matchingHighlight?.line ?? activeStep.line,
    anchor: matchingHighlight?.anchor ?? activeStep.anchor,
    title: matchingHighlight ? `Related highlight — ${activeStep.title}` : activeStep.title,
    explanation: matchingHighlight?.note ?? activeStep.explanation
  };
}

function formatSavedNote(context: CiceroneSavedNoteContext): string {
  const location = `${relativizeFilePath(context.file)}:${context.line}${context.anchor ? ` · ${context.anchor}` : ''}`;
  return [
    `- [${context.topic}] ${location}`,
    `  Tour note: ${context.explanation}`,
    `  My note: ${context.userNote}`
  ].join('\n');
}

function relativizeFilePath(file: string): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.find(folder => file.startsWith(folder.uri.fsPath));
  if (!workspaceFolder) {
    return file;
  }

  return path.relative(workspaceFolder.uri.fsPath, file) || path.basename(file);
}

async function refreshAvailableModels(): Promise<void> {
  const requestId = ++modelRefreshRequestId;
  const backendChoice = currentBackendChoice;

  if (!supportsModelSelection) {
    availableModels = [];
    syncTourOutline();
    return;
  }

  const models = await listAvailableModels(backendChoice, message => outputChannel.appendLine(message));
  if (requestId !== modelRefreshRequestId || backendChoice !== currentBackendChoice) {
    return;
  }

  availableModels = models;
  if (availableModels.length > 0) {
    outputChannel.appendLine(`[Cicerone] Available models for ${backendChoice}: ${availableModels.map(m => m.fullName).join(', ')}`);
  } else {
    if (currentModelSetting) {
      availableModels = [{
        provider: 'configured',
        modelId: currentModelSetting,
        fullName: currentModelSetting
      }];
      outputChannel.appendLine(`[Cicerone] Could not detect available models for ${backendChoice}. Falling back to configured model: ${currentModelSetting}`);
    } else {
      outputChannel.appendLine(`[Cicerone] Could not detect available models for ${backendChoice}.`);
    }
  }
  syncTourOutline();
}
