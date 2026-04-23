import * as path from 'path';
import * as vscode from 'vscode';
import { ModelInfo } from './backend/modelList';
import { CiceroneTour } from './types';

interface SidebarState {
  activeTour?: CiceroneTour;
  tourStack: readonly CiceroneTour[];
  backendLabel: string;
  questionDraft: string;
  notes: string;
  sidebarSummary: string;
  isGeneratingSummary: boolean;
  hasSession: boolean;
  currentModel: string;
  availableModels: ModelInfo[];
  isTourVisible: boolean;
  backendChoice: string;
}

export class TourOutlineProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cicerone.sidebar';
  private view?: vscode.WebviewView;
  private state: SidebarState = {
    tourStack: [],
    backendLabel: 'unknown',
    questionDraft: '',
    notes: '',
    sidebarSummary: '',
    isGeneratingSummary: false,
    hasSession: false,
    currentModel: '',
    availableModels: [],
    isTourVisible: true,
    backendChoice: 'pi-acp'
  };

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message?.type) {
        case 'goToStep':
          if (typeof message.index === 'number') {
            void vscode.commands.executeCommand('cicerone.goToStep', message.index);
          }
          break;
        case 'activateTour':
          if (typeof message.index === 'number') {
            void vscode.commands.executeCommand('cicerone.activateTourAt', message.index);
          }
          break;
        case 'discardTour':
          if (typeof message.index === 'number') {
            void vscode.commands.executeCommand('cicerone.discardTourAt', message.index);
          }
          break;
        case 'nextStep':
          void vscode.commands.executeCommand('cicerone.nextStep');
          break;
        case 'previousStep':
          void vscode.commands.executeCommand('cicerone.previousStep');
          break;
        case 'toggleAnnotationMode':
          void vscode.commands.executeCommand('cicerone.toggleAnnotationMode');
          break;
        case 'exitTour':
          void vscode.commands.executeCommand('cicerone.exitTour');
          break;
        case 'discardCurrentTour':
          void vscode.commands.executeCommand('cicerone.discardCurrentTour');
          break;
        case 'startTour':
          if (typeof message.question === 'string') {
            void vscode.commands.executeCommand('cicerone.askTourWithQuestion', message.question);
          }
          break;
        case 'questionDraftChanged':
          if (typeof message.question === 'string') {
            void vscode.commands.executeCommand('cicerone.setSidebarQuestionDraft', message.question);
          }
          break;
        case 'setBackendChoice':
          if (typeof message.choice === 'string') {
            void vscode.commands.executeCommand('cicerone.setBackendChoice', message.choice);
          }
          break;
        case 'setModel':
          if (typeof message.model === 'string') {
            void vscode.commands.executeCommand('cicerone.setModel', message.model);
          }
          break;
        case 'notesChanged':
          if (typeof message.notes === 'string') {
            void vscode.commands.executeCommand('cicerone.setSidebarNotes', message.notes);
          }
          break;
        case 'copyNotes':
          void vscode.commands.executeCommand('cicerone.copyTourNotes');
          break;
        case 'createSummary':
          void vscode.commands.executeCommand('cicerone.createSummary');
          break;
        case 'clearSummary':
          void vscode.commands.executeCommand('cicerone.clearSummary');
          break;
        case 'copySummary':
          void vscode.commands.executeCommand('cicerone.copySummary');
          break;
        case 'summaryChanged':
          if (typeof message.summary === 'string') {
            void vscode.commands.executeCommand('cicerone.setSidebarSummary', message.summary);
          }
          break;
        case 'toggleTourVisibility':
          void vscode.commands.executeCommand('cicerone.toggleTourVisibility');
          break;
      }
    });

    this.render();
  }

  setState(
    activeTour: CiceroneTour | undefined,
    tourStack: readonly CiceroneTour[],
    backendLabel: string,
    questionDraft: string,
    notes: string,
    sidebarSummary: string,
    isGeneratingSummary: boolean,
    hasSession: boolean,
    currentModel: string,
    availableModels: ModelInfo[],
    isTourVisible: boolean,
    backendChoice: string
  ): void {
    this.state = { activeTour, tourStack, backendLabel, questionDraft, notes, sidebarSummary, isGeneratingSummary, hasSession, currentModel, availableModels, isTourVisible, backendChoice };
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    this.view.webview.html = this.getHtml(this.state);
  }

  private getHtml(state: SidebarState): string {
    const { activeTour, tourStack, backendLabel, questionDraft, notes, sidebarSummary, isGeneratingSummary, hasSession, currentModel, availableModels, isTourVisible, backendChoice } = state;
    const nonce = String(Date.now());

    const backendOptionsHtml = `<select id="backendSelect" class="modelSelect">
      <option value="pi-acp"${backendChoice === 'pi-acp' ? ' selected' : ''}>pi</option>
      <option value="kiro-cli"${backendChoice === 'kiro-cli' ? ' selected' : ''}>kiro-cli</option>
      <option value="pi-rpc"${backendChoice === 'pi-rpc' ? ' selected' : ''}>pi (rpc)</option>
    </select>`;

    const modelOptionsHtml = availableModels.length
      ? `<select id="modelSelect" class="modelSelect">${availableModels
          .map(m => `<option value="${escapeHtml(m.fullName)}"${m.fullName === currentModel ? ' selected' : ''}>${escapeHtml(m.fullName)}</option>`)
          .join('')}</select>`
      : currentModel
      ? `<span class="modelLabel">${escapeHtml(currentModel)}</span>`
      : '';

    const sessionDot = hasSession
      ? '<span class="sessionDot active" title="Backend session active"></span>'
      : '<span class="sessionDot inactive" title="No active session"></span>';
    const sessionLabel = hasSession ? 'Session active' : 'No session';

    const stackHtml = tourStack.length
      ? `
        <div class="stackSection">
          <div class="sectionTitle">Tour Stack</div>
          <div class="stackList">
            ${tourStack
              .map((tour, index) => {
                const isActive = tour.id === activeTour?.id;
                const level = index + 1;
                const isRoot = !tour.parentTourId;
                const icon = isRoot ? '◆' : '◇';
                const statusClass = tour.status;
                const statusIcon = tour.status === 'loading'
                  ? '<span class="stackSpinner" aria-hidden="true"></span>'
                  : tour.status === 'error'
                  ? '<span class="stackStatusIcon">!</span>'
                  : '';
                const subtitle = tour.status === 'loading'
                  ? 'Generating…'
                  : tour.status === 'error'
                  ? escapeHtml(tour.errorMessage || 'Generation failed')
                  : tour.question
                  ? escapeHtml(tour.question)
                  : '';
                return `<div class="stackRow ${isRoot ? 'root' : 'tangent'} ${isActive ? 'active' : ''} ${statusClass}"><button class="stackChip" data-tour-index="${index}" ${tour.status !== 'ready' ? 'disabled' : ''}>${statusIcon}<span class="stackMain">${icon} #${level} ${escapeHtml(tour.topic)}</span>${subtitle ? `<span class="stackSub">${subtitle}</span>` : ''}</button><button class="stackDiscard" data-discard-tour-index="${index}" title="Discard tour">×</button></div>`;
              })
              .join('')}
          </div>
        </div>`
      : '';

    const stepProgress = activeTour
      ? `<span class="stepProgress">${activeTour.currentStepIndex + 1} / ${activeTour.steps.length}</span>`
      : '';

    const hasPrev = activeTour ? activeTour.currentStepIndex > 0 : false;
    const hasNext = activeTour ? activeTour.currentStepIndex < activeTour.steps.length - 1 : false;

    const contentHtml = !activeTour
      ? `<div class="empty">Ask a question above to generate a guided tour of the codebase.</div>`
      : !isTourVisible
      ? `<div class="empty">Tour hidden. <button class="linkButton" data-action="toggleTourVisibility">Show</button></div>`
      : `
        <div class="headerCard">
          <div class="topicRow">
            <div>
              <div class="eyebrow">Active Tour</div>
              <div class="topic">${escapeHtml(activeTour.topic)}</div>
            </div>
            <div class="badges">
              ${stepProgress}
              <div class="modeBadge">${escapeHtml(activeTour.annotationMode)}</div>
            </div>
          </div>
          ${activeTour.question ? `<div class="question">${escapeHtml(activeTour.question)}</div>` : ''}
          ${activeTour.answerSummary ? `<div class="summary">${escapeHtml(activeTour.answerSummary)}</div>` : ''}
          <div class="controls">
            <button class="controlButton${hasPrev ? '' : ' disabled'}" data-action="previousStep" ${hasPrev ? '' : 'disabled'} title="Previous step">◂ Prev</button>
            <button class="controlButton${hasNext ? '' : ' disabled'}" data-action="nextStep" ${hasNext ? '' : 'disabled'} title="Next step">Next ▸</button>
            <button class="controlButton" data-action="toggleAnnotationMode" title="Toggle annotation detail">Detail</button>
            <button class="controlButton subtle" data-action="exitTour" title="Exit current tour">Exit</button>
            <button class="controlButton subtle danger" data-action="discardCurrentTour" title="Discard current tour">Drop</button>
          </div>
        </div>
        <div class="sectionTitle">Steps</div>
        <div class="steps">
          ${activeTour.steps
            .map((step, index) => {
              const isActive = index === activeTour.currentStepIndex;
              const isComplete = index < activeTour.currentStepIndex;
              const fileLabel = `${path.basename(step.file)}:${step.line}${step.anchor ? ` · ${step.anchor}` : ''}`;
              const description = isActive
                ? stripMarkdown(activeTour.annotationMode === 'detailed' ? step.detailedExplanation || step.explanation : step.explanation)
                : abbreviate(stripMarkdown(step.explanation), 110);
              const typeIcon = step.type === 'concept' ? '💡' : step.type === 'execution' ? '⚡' : '↗';
              const check = isComplete ? ' ✓' : '';
              return `
                <button class="step ${isActive ? 'active' : ''} ${isComplete ? 'complete' : ''}" data-index="${index}">
                  <div class="stepHeader">
                    <span class="stepNumber">${isComplete ? '✓' : index + 1}</span>
                    <span class="stepTitle">${escapeHtml(step.title)}${check}</span>
                    <span class="stepType">${typeIcon} ${step.type}</span>
                  </div>
                  <div class="file">${escapeHtml(fileLabel)}</div>
                  <div class="description ${isActive ? 'expanded' : 'compact'}">${escapeHtml(description)}</div>
                </button>
              `;
            })
            .join('')}
        </div>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; margin: 0; }
    .composer, .headerCard, .stackSection, .step {
      border: 1px solid var(--vscode-panel-border); border-radius: 12px;
      background: var(--vscode-editorWidget-background);
    }
    .composer { padding: 12px; margin-bottom: 16px; }
    .composerTitle, .sectionTitle {
      font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
      color: var(--vscode-descriptionForeground); margin-bottom: 8px;
    }
    .composerMeta { display: flex; justify-content: space-between; gap: 8px; align-items: center; margin-bottom: 8px; }
    .sessionLine {
      display: flex; align-items: center; gap: 6px;
      font-size: 11px; color: var(--vscode-descriptionForeground);
      padding: 4px 0 8px;
    }
    .sessionDot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    }
    .sessionDot.active { background: #4caf50; box-shadow: 0 0 4px #4caf5080; }
    .sessionDot.inactive { background: var(--vscode-descriptionForeground); opacity: .4; }
    .backendBadge {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px;
    }
    .questionInput {
      width: 100%; border-radius: 8px; border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      padding: 10px 12px; resize: vertical; min-height: 72px; font-family: inherit; font-size: 13px;
    }
    .notesComposer { margin-top: 16px; }
    .notesInput { min-height: 140px; font-family: var(--vscode-editor-font-family, monospace); }
    .startButton, .controlButton {
      border: 1px solid var(--vscode-button-border, transparent); border-radius: 8px; cursor: pointer;
      padding: 8px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      font-family: inherit; font-size: 12px;
    }
    .startButton:hover, .controlButton:hover:not(.disabled) { background: var(--vscode-button-hoverBackground); }
    .composerActions, .controls { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .headerCard { padding: 14px; margin-bottom: 12px; }
    .topicRow { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .eyebrow {
      color: var(--vscode-descriptionForeground); font-size: 11px;
      text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px;
    }
    .topic { font-size: 17px; font-weight: 600; line-height: 1.3; }
    .badges { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
    .stepProgress {
      font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground);
      font-variant-numeric: tabular-nums;
    }
    .modeBadge {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 8px;
    }
    .question { margin-top: 8px; font-size: 12px; color: var(--vscode-foreground); }
    .summary { margin-top: 8px; font-size: 12px; color: var(--vscode-descriptionForeground); line-height: 1.45; }
    .controlButton.subtle { background: transparent; color: var(--vscode-foreground); border-color: var(--vscode-panel-border); }
    .controlButton.subtle:hover:not(.disabled) { background: var(--vscode-list-hoverBackground); }
    .controlButton.disabled { opacity: .4; cursor: default; }
    .danger { color: var(--vscode-errorForeground) !important; }
    .stackSection { padding: 12px; margin-bottom: 12px; }
    .stackList { display: flex; flex-direction: column; gap: 8px; }
    .stackRow {
      display: flex; align-items: stretch; gap: 2px;
      background: var(--vscode-badge-background); border-radius: 12px;
      transition: outline .15s; width: 100%;
      opacity: .9;
    }
    .stackRow.root { margin-left: 0; width: 100%; }
    .stackRow.tangent { margin-left: 18px; width: calc(100% - 18px); }
    .stackRow.active { outline: 1.5px solid var(--vscode-focusBorder); }
    .stackRow.loading {
      background: color-mix(in srgb, var(--vscode-badge-background) 75%, var(--vscode-editorWidget-background));
      opacity: .72;
    }
    .stackRow.ready {
      background: color-mix(in srgb, var(--vscode-list-inactiveSelectionBackground) 70%, var(--vscode-editorWidget-background));
      opacity: 1;
    }
    .stackRow.error {
      background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 55%, var(--vscode-editorWidget-background));
    }
    .stackChip {
      font-size: 11px; padding: 8px 6px 8px 10px; background: transparent;
      color: var(--vscode-badge-foreground); border: none; cursor: pointer; text-align: left; flex: 1;
      display: flex; flex-direction: column; gap: 2px;
    }
    .stackChip:disabled { cursor: default; opacity: 1; }
+    .stackMain { display: flex; align-items: center; gap: 6px; font-weight: 600; }
+    .stackSub {
+      color: var(--vscode-descriptionForeground);
+      font-size: 10px;
+      white-space: nowrap;
+      overflow: hidden;
+      text-overflow: ellipsis;
+      max-width: 100%;
+    }
+    .stackStatusIcon {
+      color: #4ea1ff;
+      font-size: 10px;
+      line-height: 1;
+    }
+    .stackRow.error .stackStatusIcon { color: var(--vscode-errorForeground); font-weight: 700; }
+    .stackSpinner {
+      width: 10px; height: 10px; border-radius: 50%;
+      border: 2px solid var(--vscode-descriptionForeground);
+      border-top-color: transparent;
+      display: inline-block;
+      animation: cicerone-spin 0.8s linear infinite;
+      flex-shrink: 0;
+    }
+    @keyframes cicerone-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .stackDiscard {
      background: transparent; border: none; color: var(--vscode-badge-foreground);
      cursor: pointer; padding: 2px 10px 2px 2px; font-size: 15px; line-height: 1; opacity: .7;
    }
    .stackDiscard:hover { opacity: 1; }
    .steps { display: flex; flex-direction: column; gap: 10px; }
    .step { width: 100%; text-align: left; padding: 13px; color: inherit; cursor: pointer; }
    .step:hover { border-color: var(--vscode-focusBorder); }
    .step.active {
      border-color: var(--vscode-focusBorder);
      background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 70%, var(--vscode-editorWidget-background));
      box-shadow: inset 0 0 0 1px var(--vscode-focusBorder);
    }
    .step.complete { opacity: .78; }
    .stepHeader { display: flex; gap: 8px; align-items: baseline; margin-bottom: 7px; }
    .stepNumber {
      color: var(--vscode-descriptionForeground); font-size: 13px; min-width: 18px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .step.active .stepNumber { color: var(--vscode-focusBorder); font-weight: 700; }
    .stepTitle { font-weight: 600; line-height: 1.35; flex: 1; font-size: 13px; }
    .stepType {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      background: var(--vscode-badge-background); border-radius: 999px; padding: 2px 6px;
      white-space: nowrap;
    }
    .file { color: var(--vscode-textLink-foreground); font-size: 12.5px; margin-bottom: 7px; font-family: var(--vscode-editor-font-family, monospace); }
    .description, .empty { color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.5; }
    .description.compact {
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .description.expanded {
      color: var(--vscode-foreground);
    }
    .empty { text-align: center; padding: 24px 12px; }
    .linkButton { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
    .visibilityToggle { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 4px; font-size: 14px; display: flex; align-items: center; }
    .visibilityToggle:hover { color: var(--vscode-foreground); }
    .modelRow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .modelRow > * { flex: 1; }
    .modelSelect {
      width: 100%; font-size: 11px; border-radius: 8px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); padding: 4px 8px;
    }
    .modelLabel { font-size: 11px; color: var(--vscode-descriptionForeground); }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-textCodeBlock-background);
      padding: 1px 4px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  ${stackHtml}
  <div class="composer">
    <div class="composerMeta">
      <div class="composerTitle">Ask Cicerone</div>
      <div class="badges">
        <button class="visibilityToggle" data-action="toggleTourVisibility" title="${isTourVisible ? 'Hide tour' : 'Show tour'}">${isTourVisible ? '👁' : '👁‍🗨'}</button>
        <div class="backendBadge">${escapeHtml(backendLabel)}</div>
      </div>
    </div>
    <div class="modelRow">
      ${backendOptionsHtml}
      ${modelOptionsHtml || ''}
    </div>
    <textarea id="questionInput" class="questionInput" placeholder="How does lineup generation work?">${escapeHtml(questionDraft)}</textarea>
    <div class="composerActions">
      <button id="startTourButton" class="startButton">Start</button>
    </div>
    <div class="sessionLine">${sessionDot} ${sessionLabel}</div>
  </div>
  ${contentHtml}
  <div class="composer notesComposer">
    <div class="composerMeta">
      <div class="composerTitle">Tour Notes</div>
      <div class="badges">
        <button id="copyNotesButton" class="controlButton" title="Copy notes to clipboard">Copy</button>
      </div>
    </div>
    <textarea id="notesInput" class="questionInput notesInput" placeholder="Saved tour notes will appear here…">${escapeHtml(notes)}</textarea>
    <div class="sessionLine">Use the <code>Tangent / Note</code> toggle in the tour comment to decide whether the reply opens a tangent or saves a note.</div>
  </div>
  <div class="composer notesComposer">
    <div class="composerMeta">
      <div class="composerTitle">Session Summary</div>
      <div class="badges">
        <button id="createSummaryButton" class="controlButton" title="Generate a session summary" ${isGeneratingSummary ? 'disabled' : ''}>${isGeneratingSummary ? 'Generating…' : 'Generate'}</button>
        <button id="copySummaryButton" class="controlButton" title="Copy summary" ${!sidebarSummary ? 'disabled' : ''}>Copy</button>
      </div>
    </div>
    ${isGeneratingSummary 
      ? `<div class="empty" style="padding:12px;">Generating summary... <span class="stackSpinner" style="display:inline-block; vertical-align:middle; margin-left:4px;"></span></div>`
      : `<textarea id="summaryInput" class="questionInput notesInput" placeholder="Generate a summary of the full session...">${escapeHtml(sidebarSummary)}</textarea>`
    }
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const questionInput = document.getElementById('questionInput');
    const startTourButton = document.getElementById('startTourButton');
    startTourButton?.addEventListener('click', () => {
      const question = questionInput?.value?.trim();
      if (!question) return;
      vscode.postMessage({ type: 'startTour', question });
    });
    questionInput?.addEventListener('input', () => {
      vscode.postMessage({ type: 'questionDraftChanged', question: questionInput?.value ?? '' });
    });
    questionInput?.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        startTourButton?.click();
      }
    });
    const backendSelect = document.getElementById('backendSelect');
    backendSelect?.addEventListener('change', () => {
      vscode.postMessage({ type: 'setBackendChoice', choice: backendSelect.value });
    });
    const modelSelect = document.getElementById('modelSelect');
    modelSelect?.addEventListener('change', () => {
      vscode.postMessage({ type: 'setModel', model: modelSelect.value });
    });
    const notesInput = document.getElementById('notesInput');
    notesInput?.addEventListener('input', () => {
      vscode.postMessage({ type: 'notesChanged', notes: notesInput?.value ?? '' });
    });
    const copyNotesButton = document.getElementById('copyNotesButton');
    copyNotesButton?.addEventListener('click', () => {
      vscode.postMessage({ type: 'copyNotes' });
    });
    const createSummaryButton = document.getElementById('createSummaryButton');
    createSummaryButton?.addEventListener('click', () => {
      vscode.postMessage({ type: 'createSummary' });
    });
    const clearSummaryButton = document.getElementById('clearSummaryButton');
    clearSummaryButton?.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearSummary' });
    });
    const copySummaryButton = document.getElementById('copySummaryButton');
    copySummaryButton?.addEventListener('click', () => {
      vscode.postMessage({ type: 'copySummary' });
    });
    const summaryInput = document.getElementById('summaryInput');
    summaryInput?.addEventListener('input', () => {
      vscode.postMessage({ type: 'summaryChanged', summary: summaryInput?.value ?? '' });
    });
    for (const button of document.querySelectorAll('.step')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'goToStep', index: Number(button.dataset.index) });
      });
    }
    for (const button of document.querySelectorAll('[data-tour-index]')) {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'activateTour', index: Number(button.dataset.tourIndex) });
      });
    }
    for (const button of document.querySelectorAll('[data-discard-tour-index]')) {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'discardTour', index: Number(button.dataset.discardTourIndex) });
      });
    }
    for (const button of document.querySelectorAll('[data-action]')) {
      button.addEventListener('click', () => {
        if (button.disabled) return;
        vscode.postMessage({ type: button.dataset.action });
      });
    }
  </script>
</body>
</html>`;
  }
}

function abbreviate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function stripMarkdown(text: string): string {
  return text.replace(/[*_`>#\[\]()!-]/g, '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
