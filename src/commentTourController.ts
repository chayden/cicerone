import * as path from 'path';
import * as vscode from 'vscode';
import { CiceroneStep, CiceroneStepHighlight, CiceroneTour } from './types';

class CiceroneComment implements vscode.Comment {
  id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  label?: string | undefined;
  mode = vscode.CommentMode.Preview;
  author: vscode.CommentAuthorInformation;
  contextValue = 'cicerone.step';
  reactions?: vscode.CommentReaction[] | undefined;
  savedBody?: string | vscode.MarkdownString | undefined;

  constructor(public body: string | vscode.MarkdownString, iconPath: vscode.Uri) {
    this.author = { name: 'Cicerone', iconPath };
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

  constructor() {
    this.controller = vscode.comments.createCommentController('cicerone-tour', 'Cicerone Tour');
    this.authorIconPath = vscode.Uri.file(path.resolve(__dirname, '../media/cicerone.svg'));
    this.controller.options = {
      prompt: 'Dive deeper',
      placeHolder: 'Ask for a tangent, deeper explanation, or implementation detail…'
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

  async renderStep(tour: CiceroneTour, step: CiceroneStep): Promise<void> {
    const document = await vscode.workspace.openTextDocument(step.file);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const lineIndex = this.clampLine(step.line - 1, document.lineCount);
    const line = document.lineAt(lineIndex);
    const range = new vscode.Range(line.range.start, line.range.end);

    this.currentThread?.dispose();
    this.extraThreads.forEach(thread => thread.dispose());
    this.extraThreads = [];

    this.currentThread = this.controller.createCommentThread(document.uri, range, [
      new CiceroneComment(this.buildMarkdown(step), this.authorIconPath)
    ]);
    this.currentThread.label = `Tour: ${tour.topic}`;
    this.currentThread.contextValue = 'cicerone.tourThread';
    this.currentThread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.currentThread.canReply = true;

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

  private buildMarkdown(step: CiceroneStep): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = true;

    // Use brief explanation as the primary intro
    markdown.appendMarkdown(`**${escapeMarkdown(step.explanation)}**\n\n`);

    // Use detailed explanation (usually 3-ish sentences) as the body
    if (step.detailedExplanation && step.detailedExplanation !== step.explanation) {
      markdown.appendMarkdown(`${step.detailedExplanation}`);
    }

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
      const thread = this.controller.createCommentThread(document.uri, range, [
        new CiceroneComment(highlight.note, this.authorIconPath)
      ]);
      thread.label = 'Related highlight';
      thread.contextValue = 'cicerone.tourThread';
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      thread.canReply = false;
      this.extraThreads.push(thread);
      return range;
    });
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
