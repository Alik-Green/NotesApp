/**
 * Undo/redo stack (command pattern).
 *
 * - Unlimited undo/redo within a session, capped at `cap` (500) commands, trimmed oldest first.
 * - `BatchCommand`/`runBatch` group many mutations (e.g. one eraser drag) into a single step.
 * - The history is serialisable so it can be persisted per notebook and restored on reload.
 */

import type { NotebookDocument } from './document';
import { BatchCommand, commandFromData, pagesAffectedBy, type Command, type CommandData } from './commands';

export interface CommandStackOptions {
  cap?: number;
  onSettled?: () => void;
}

export class CommandStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private batchDepth = 0;
  private batchCommands: Command[] = [];
  private batchLabel = '';
  readonly cap: number;
  private onSettled?: () => void;

  constructor(
    readonly doc: NotebookDocument,
    options: CommandStackOptions = {},
  ) {
    this.cap = options.cap ?? 500;
    this.onSettled = options.onSettled;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  get redoCount(): number {
    return this.redoStack.length;
  }

  /** Run a command and push it onto the undo stack. */
  execute(command: Command): void {
    command.apply(this.doc);
    if (this.batchDepth > 0) {
      this.batchCommands.push(command);
      return;
    }
    this.pushUndo(command);
    this.redoStack = [];
    this.onSettled?.();
  }

  private pushUndo(command: Command): void {
    this.undoStack.push(command);
    if (this.undoStack.length > this.cap) {
      this.undoStack.splice(0, this.undoStack.length - this.cap);
    }
  }

  /** Group commands into one undo step. Nesting flattens into the outer batch. */
  runBatch(label: string, fn: () => void): void {
    this.beginBatch(label);
    try {
      fn();
    } finally {
      this.endBatch();
    }
  }

  beginBatch(label: string): void {
    if (this.batchDepth === 0) {
      this.batchCommands = [];
      this.batchLabel = label;
    }
    this.batchDepth++;
  }

  endBatch(): void {
    if (this.batchDepth === 0) return;
    this.batchDepth--;
    if (this.batchDepth > 0) return;
    const commands = this.batchCommands;
    this.batchCommands = [];
    if (commands.length === 0) return;
    if (commands.length === 1) {
      this.pushUndo(commands[0]!);
    } else {
      this.pushUndo(new BatchCommand(commands, this.batchLabel));
    }
    this.redoStack = [];
    this.onSettled?.();
  }

  undo(): Command | null {
    const command = this.undoStack.pop();
    if (!command) return null;
    command.revert(this.doc);
    this.redoStack.push(command);
    this.onSettled?.();
    return command;
  }

  redo(): Command | null {
    const command = this.redoStack.pop();
    if (!command) return null;
    command.apply(this.doc);
    this.pushUndo(command);
    this.onSettled?.();
    return command;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.batchDepth = 0;
    this.batchCommands = [];
  }

  /** Pages touched by the commands currently on the stack (for dirty tracking). */
  touchedPageIds(): string[] {
    const ids = new Set<string>();
    for (const c of [...this.undoStack, ...this.redoStack]) {
      for (const id of pagesAffectedBy(c.toData())) ids.add(id);
    }
    return [...ids];
  }

  toData(): HistoryData {
    return { entries: this.undoStack.map((c) => c.toData()), redo: this.redoStack.map((c) => c.toData()) };
  }

  /** Restore a persisted history without replaying it (the document already holds the state). */
  static restore(doc: NotebookDocument, data: HistoryData, options: CommandStackOptions = {}): CommandStack {
    const stack = new CommandStack(doc, options);
    for (const entry of data.entries) stack.undoStack.push(commandFromData(entry));
    for (const entry of data.redo ?? []) stack.redoStack.push(commandFromData(entry));
    if (stack.undoStack.length > stack.cap) {
      stack.undoStack.splice(0, stack.undoStack.length - stack.cap);
    }
    return stack;
  }

  /** Human-readable history for the debug panel / tests. */
  history(): { label: string; kind: string; undone: boolean }[] {
    return [
      ...this.undoStack.map((c) => ({ label: c.label, kind: c.kind, undone: false })),
      ...this.redoStack
        .slice()
        .reverse()
        .map((c) => ({ label: c.label, kind: c.kind, undone: true })),
    ];
  }
}

export interface HistoryData {
  entries: CommandData[];
  redo?: CommandData[];
}

