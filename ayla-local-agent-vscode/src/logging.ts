import * as vscode from "vscode";

export class Logger {
  public readonly channel = vscode.window.createOutputChannel("Ayla Local Agent");

  info(message: string): void {
    this.channel.appendLine(`[info] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[error] ${message}`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
