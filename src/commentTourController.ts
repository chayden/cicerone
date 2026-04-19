import * as path from 'path';
import * as vscode from 'vscode';
import { CiceroneStep, CiceroneStepHighlight, CiceroneTour } from './types';

type ReplyMode = 'hidden' | 'tangent' | 'note';
type ThreadKind = 'main' | 'highlight';

class CiceroneComment implements vscode.Comment {
  id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  label?: string | undefined;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue = 'cicerone.step';
  reactions?: vscode.CommentReaction[] | undefined;
  savedBody?: string | vscode.MarkdownString | undefined;

  constructor(public body: string | vscode.MarkdownString, iconPath: vscode.Uri, authorName: string = '') {
    this.author = { name: authorName, iconPath };
  }
}

export class CommentTourController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private currentThread?: vscode.CommentThread;
  private extraThreads: vscode.CommentThread[] = [];
  private readonly blockDecoration: vscode.TextEditorDecorationType;
  private readonly extraBlockDecoration: vscode.TextEditorDecorationType;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly authorIconPath: vscode.Uri;
  private readonly secondaryIconPath: vscode.Uri;
  private readonly replyModes = new Map<string, ReplyMode>();

  constructor() {
    this.controller = vscode.comments.createCommentController('cicerone-tour', 'Cicerone Tour');
    this.authorIconPath = vscode.Uri.file(path.resolve(__dirname, '../media/cicerone.svg'));
    this.secondaryIconPath = vscode.Uri.file(path.resolve(__dirname, '../media/cicerone-secondary.svg'));
    this.controller.options = {
      prompt: 'Open tangent',
      placeHolder: 'Ask a follow-up to open a tangent…'
    };
    this.blockDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightStrongBackground'),
      overviewRulerColor: new vscode.ThemeColor('editor.wordHighlightStrongBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.wordHighlightStrongBorder')
    });
    this.extraBlockDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.wordHighlightTextBackground'),
      overviewRulerColor: new vscode.ThemeColor('editor.wordHighlightTextBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editor.wordHighlightTextBorder')
    });
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  }

  setReplyMode(threadKey: string, mode: ReplyMode): void {
    this.replyModes.set(threadKey, mode);
    this.controller.options = {
      prompt: mode === 'note' ? 'Save note' : 'Open tangent',
      placeHolder: mode === 'note'
        ? 'Reply text will be saved to your sidebar notes…'
        : 'Ask a follow-up to open a tangent…'
    };
  }

  getReplyMode(threadKey: string): ReplyMode {
    return this.replyModes.get(threadKey) ?? 'hidden';
  }

  getThreadKey(uri: vscode.Uri, line: number, kind: ThreadKind): string {
    return `${kind}:${uri.toString()}:${line}`;
  }

  getThreadKeyFromReply(thread: vscode.CommentThread): string {
    const line = (thread.range?.start.line ?? 0) + 1;
    const kind: ThreadKind = thread.label === 'Related highlight' ? 'highlight' : 'main';
    return this.getThreadKey(thread.uri, line, kind);
  }

  async renderStep(tour: CiceroneTour, step: CiceroneStep): Promise<void> {
    const document = await vscode.workspace.openTextDocument(step.file);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const lineIndex = this.clampLine(step.line - 1, document.lineCount);
    const line = document.lineAt(lineIndex);
    const range = new vscode.Range(line.range.start, line.range.end);
    const mainThreadKey = this.getThreadKey(document.uri, lineIndex + 1, 'main');
    const mainReplyMode = this.getReplyMode(mainThreadKey);

    this.currentThread?.dispose();
    this.extraThreads.forEach(thread => thread.dispose());
    this.extraThreads = [];

    this.currentThread = this.controller.createCommentThread(document.uri, range, [
      new CiceroneComment(this.buildMarkdown(step, mainThreadKey, mainReplyMode), this.authorIconPath, step.authorName || 'Cicerone')
    ]);
    this.currentThread.label = `Tour: ${tour.topic}`;
    this.currentThread.contextValue = 'cicerone.tourThread';
    this.currentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.currentThread.canReply = mainReplyMode !== 'hidden';

    const extraRanges = this.renderExtraHighlights(document, step.extraHighlights);

    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.setDecorations(this.blockDecoration, [range]);
    editor.setDecorations(this.extraBlockDecoration, extraRanges);

    this.statusBarItem.text = `$(book) Cicerone: ${tour.currentStepIndex + 1}/${tour.steps.length}`;
    this.statusBarItem.tooltip = `${tour.topic} — ${step.title}`;
    this.statusBarItem.show();
  }

  clear(): void {
    this.currentThread?.dispose();
    this.currentThread = undefined;
    this.extraThreads.forEach(thread => thread.dispose());
    this.extraThreads = [];

    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.blockDecoration, []);
      editor.setDecorations(this.extraBlockDecoration, []);
    }

    this.statusBarItem.hide();
  }

  dispose(): void {
    this.clear();
    this.controller.dispose();
    this.blockDecoration.dispose();
    this.extraBlockDecoration.dispose();
    this.statusBarItem.dispose();
  }

  private buildMarkdown(step: CiceroneStep, threadKey: string, replyMode: ReplyMode): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;

    markdown.appendMarkdown(`**${escapeMarkdown(step.explanation)}**\n\n`);

    if (step.detailedExplanation && step.detailedExplanation !== step.explanation) {
      markdown.appendMarkdown(`${step.detailedExplanation}`);
    }

    markdown.appendMarkdown(`\n\n— ${replyMode === 'tangent' ? '**Tangent**' : commandLink('Tangent', 'cicerone.setReplyModeTangent', threadKey)} / ${replyMode === 'note' ? '**Note**' : commandLink('Note', 'cicerone.setReplyModeNote', threadKey)}${replyMode !== 'hidden' ? ` / ${commandLink('Hide', 'cicerone.setReplyModeHidden', threadKey)}` : ''}`);

    return markdown;
  }

  private renderExtraHighlights(document: vscode.TextDocument, highlights?: CiceroneStepHighlight[]): vscode.Range[] {
    if (!highlights?.length) {
      return [];
    }

    return highlights.map(highlight => {
      const lineIndex = this.clampLine(highlight.line - 1, document.lineCount);
      const line = document.lineAt(lineIndex);
      const range = new vscode.Range(line.range.start, line.range.end);
      const threadKey = this.getThreadKey(document.uri, lineIndex + 1, 'highlight');
      const replyMode = this.getReplyMode(threadKey);
      const thread = this.controller.createCommentThread(document.uri, range, [
        new CiceroneComment(this.buildHighlightMarkdown(highlight, threadKey, replyMode), this.secondaryIconPath, highlight.authorName || '')
      ]);
      thread.label = 'Related highlight';
      thread.contextValue = 'cicerone.tourThread';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = replyMode !== 'hidden';
      this.extraThreads.push(thread);
      return range;
    });
  }

  private buildHighlightMarkdown(highlight: CiceroneStepHighlight, threadKey: string, replyMode: ReplyMode): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;
    markdown.appendMarkdown(`**${escapeMarkdown(highlight.note)}**`);
    markdown.appendMarkdown(`\n\n— ${replyMode === 'tangent' ? '**Tangent**' : commandLink('Tangent', 'cicerone.setReplyModeTangent', threadKey)} / ${replyMode === 'note' ? '**Note**' : commandLink('Note', 'cicerone.setReplyModeNote', threadKey)}${replyMode !== 'hidden' ? ` / ${commandLink('Hide', 'cicerone.setReplyModeHidden', threadKey)}` : ''}`);
    return markdown;
  }

  private clampLine(line: number, lineCount: number): number {
    if (lineCount <= 0) {
      return 0;
    }

    return Math.max(0, Math.min(line, lineCount - 1));
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, '\\$1');
}

function commandLink(label: string, command: string, threadKey: string): string {
  return `[${label}](command:${command}?${encodeURIComponent(JSON.stringify([threadKey]))})`;
}
