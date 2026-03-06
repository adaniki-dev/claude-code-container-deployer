export interface SessionManager {
  startContainer(telegramId: number): Promise<string>;
  stopContainer(telegramId: number): Promise<void>;
  isContainerRunning(telegramId: number): Promise<boolean>;
  waitForReady(telegramId: number, timeoutMs?: number): Promise<boolean>;
  isClaudeAuthenticated(telegramId: number): Promise<boolean>;
  /** Store the CLAUDE_CODE_OAUTH_TOKEN in the container */
  setupToken(telegramId: number, token: string): Promise<void>;
  startRemoteControl(telegramId: number): Promise<string>;
  stopRemoteControl(telegramId: number): Promise<void>;
  executePrompt(telegramId: number, prompt: string, timeoutMs?: number): Promise<string>;
}
