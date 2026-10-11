import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  appendFilesInputTag,
  buildCodexInputItems,
  createCompleteMessage,
  createNormalizedMessage,
  parseFilesInputTag,
  sliceTailPage,
} from '@/shared/index.js';
import type {
  AnyRecord,
  FetchHistoryResult,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderSessionActivity,
  ProviderRuntimeWriter,
} from '@/shared/index.js';

// The desktop app's local follower protocol is versioned separately from the
// CLI app-server protocol. CloudCLI registers its own identity and forwards to
// the discovered owner; it never starts another writer for that thread.
const VERSIONS: Record<string, number> = {
  initialize: 0,
  'thread-stream-state-changed': 11,
  'thread-stream-following-changed': 1,
  'thread-owner-discovery': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-load-complete-history': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-command-approval-decision': 1,
  'thread-follower-file-approval-decision': 1,
};
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
type PendingRequest = {
  resolve(value: AnyRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type DesktopRun = {
  client: DesktopThreadClient;
  controller: AbortController;
  turnId: string | null;
  clientUserMessageId: string;
  dispatched: boolean;
};
type DesktopApproval = {
  run: DesktopRun;
  nativeRequestId: string | number;
  method: string;
  message: NormalizedMessage;
  writer: ProviderRuntimeWriter;
};
const runs = new Map<string, DesktopRun>();
const connectingRuns = new Map<string, AbortController>();
const observedClients = new Map<string, Set<DesktopThreadClient>>();
const approvals = new Map<string, DesktopApproval>();

function send(writer: ProviderRuntimeWriter, message: NormalizedMessage) {
  writer.send(writer.isSSEStreamWriter || writer.isWebSocketWriter ? message : JSON.stringify(message));
}

function turnsFromState(state: AnyRecord): AnyRecord[] {
  const history = state.turnHistory?.history;
  if (state.turnHistory?.kind === 'canonical' && history) {
    return (history.islands || []).flatMap((island: AnyRecord) =>
      (island.entries || []).map((entry: AnyRecord) => history.entitiesByKey?.[entry.value]).filter(Boolean));
  }
  return Array.isArray(state.turns) ? state.turns : [];
}

function tokenBudgetFromState(state: AnyRecord | null): AnyRecord | undefined {
  const info = state?.latestTokenUsageInfo;
  const usage = info?.total;
  if (!usage) return undefined;
  return {
    used: usage.totalTokens || 0,
    total: info.modelContextWindow || 200000,
    inputTokens: usage.inputTokens || 0,
    outputTokens: usage.outputTokens || 0,
  };
}

function applyStatePatches(state: AnyRecord, patches: AnyRecord[]): AnyRecord {
  for (const patch of patches) {
    const keys = patch.path;
    if (!Array.isArray(keys) || keys.some(key =>
      (typeof key !== 'string' && typeof key !== 'number') || FORBIDDEN_KEYS.has(String(key)))) {
      throw new Error('Unsupported Codex desktop state patch');
    }
    if (keys.length === 0) {
      if (patch.op !== 'replace' || !patch.value || typeof patch.value !== 'object') {
        throw new Error('Unsupported Codex desktop state replacement');
      }
      state = patch.value;
      continue;
    }
    let parent = state;
    for (const key of keys.slice(0, -1)) {
      if (!parent || !Object.hasOwn(parent, key)) throw new Error('Codex desktop state is out of sync');
      parent = parent[key];
    }
    const key = keys[keys.length - 1];
    if (!parent || typeof parent !== 'object') throw new Error('Invalid Codex desktop state patch');
    if (patch.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else if (patch.op === 'add' || patch.op === 'replace') {
      if (Array.isArray(parent) && patch.op === 'add') parent.splice(Number(key), 0, patch.value);
      else (parent as AnyRecord)[key] = patch.value;
    } else throw new Error('Unsupported Codex desktop state patch operation');
  }
  return state;
}

class DesktopThreadClient {
  connectedAt = Date.now();
  owner = '';
  state: AnyRecord | null = null;
  revision = -1;
  private clientId = 'initializing-client';
  private buffer = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<() => void>();
  private failure: Error | null = null;
  private following = false;
  private socket: net.Socket;

  get error() { return this.failure; }

  constructor(readonly threadId: string, socketPath: string) {
    this.socket = net.connect(socketPath);
    this.socket.on('error', error => this.fail(error));
    this.socket.on('close', () => this.fail(new Error('电脑 Codex 连接已断开，请查看原对话后再发送，避免重复提交。')));
    this.socket.on('data', data => {
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        while (this.buffer.length >= 4) {
          const length = this.buffer.readUInt32LE(0);
          if (!length || length > MAX_FRAME_BYTES) throw new Error('Invalid Codex desktop IPC frame');
          if (this.buffer.length < length + 4) break;
          const message = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'));
          this.buffer = this.buffer.subarray(length + 4);
          this.receive(message);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.socket.destroy();
      }
    });
  }

  private fail(error: Error) {
    this.failure ??= error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(this.failure);
    }
    this.pending.clear();
    this.changed();
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private write(message: AnyRecord) {
    if (this.failure) throw this.failure;
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME_BYTES) throw new Error('Codex desktop request is too large');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }

  private receive(message: AnyRecord) {
    if (message.type === 'response') {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      this.pending.delete(message.requestId);
      clearTimeout(entry.timer);
      if (message.resultType === 'success') entry.resolve(message);
      else entry.reject(new Error(message.error || 'Codex desktop request failed'));
    } else if (message.type === 'client-discovery-request') {
      this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
    } else if (message.type === 'broadcast' && message.method === 'thread-stream-state-changed' &&
      message.sourceClientId === this.owner && message.params?.hostId === 'local' &&
      message.params?.conversationId === this.threadId) {
      if (message.version !== VERSIONS['thread-stream-state-changed']) {
        throw new Error('电脑 Codex 的通信版本已变化，请更新 CloudCLI 后继续。');
      }
      const change = message.params.change;
      if (change?.type === 'snapshot') {
        this.state = change.conversationState;
        this.revision = change.revision;
      } else if (change?.type === 'patches') {
        if (change.revision <= this.revision) return;
        if (!this.state || change.baseRevision !== this.revision) {
          this.follow(true);
          return;
        }
        this.state = applyStatePatches(this.state, change.patches || []);
        this.revision = change.revision;
      }
      this.changed();
    } else if (message.method === 'client-status-changed' &&
      message.params?.clientId === this.owner && message.params?.status === 'disconnected') {
      this.fail(new Error('持有对话的电脑 Codex 已关闭，请重新打开原对话。'));
    }
  }

  async request(method: string, params: AnyRecord, timeoutMs = 12000, targeted = true): Promise<AnyRecord> {
    if (this.failure) throw this.failure;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('电脑 Codex 请求超时，请查看原对话确认是否已收到消息，避免重复提交。'));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.write({
          type: 'request', requestId, method, params,
          version: VERSIONS[method],
          sourceClientId: this.clientId,
          targetClientId: targeted ? this.owner : undefined,
          timeoutMs: Math.max(1000, timeoutMs - 1000),
        });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async initialize(): Promise<boolean> {
    const initialized = await this.request('initialize', { clientType: 'cloudcli' }, 5000, false);
    this.clientId = initialized.result.clientId;
    try {
      const discovery = await this.request('thread-owner-discovery',
        { hostId: 'local', conversationId: this.threadId }, 5000, false);
      this.owner = discovery.handledByClientId;
      if (!this.owner) throw new Error('Codex desktop returned no thread owner');
      this.follow(true);
      await this.waitFor(state => Boolean(state), undefined, 12000);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === 'no-client-found') return false;
      throw error;
    }
  }

  private follow(following: boolean) {
    this.following = following;
    this.write({
      type: 'broadcast', method: 'thread-stream-following-changed',
      version: VERSIONS['thread-stream-following-changed'],
      sourceClientId: this.clientId, targetClientIds: [this.owner],
      params: { hostId: 'local', conversationId: this.threadId, following },
    });
  }

  waitFor(predicate: (state: AnyRecord) => boolean, signal?: AbortSignal, timeoutMs = 30 * 60 * 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new Error('Codex desktop run aborted'));
      const check = () => {
        try {
          if (this.failure) finish(this.failure);
          else if (signal?.aborted) aborted();
          else if (this.state && predicate(this.state)) finish();
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      const timer = setTimeout(() => finish(new Error('等待电脑 Codex 超时，请查看原对话。')), timeoutMs);
      this.listeners.add(check);
      signal?.addEventListener('abort', aborted, { once: true });
      check();
    });
  }

  onState(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    if (this.following && !this.failure) this.follow(false);
    this.socket.destroy();
  }
}

async function connectThread(threadId: string): Promise<DesktopThreadClient | null> {
  if (process.platform === 'win32') return null;
  const socketPath = process.env.CLOUDCLI_CODEX_DESKTOP_SOCKET ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ipc', 'ipc.sock');
  try {
    const [socket, directory] = await Promise.all([lstat(socketPath), lstat(path.dirname(socketPath))]);
    const uid = process.getuid?.();
    if (uid === undefined || !socket.isSocket() || socket.uid !== uid ||
      !directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o022) ||
      (socket.mode & 0o077)) throw new Error('Codex desktop IPC must be private and owned by the CloudCLI user');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const client = new DesktopThreadClient(threadId, socketPath);
  try {
    if (await client.initialize()) return client;
    client.close();
    return null;
  } catch (error) {
    client.close();
    if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code || '')) return null;
    throw error;
  }
}

function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  return Array.isArray(input) ? input.map(item => typeof item === 'string' ? item : item?.text || '').filter(Boolean).join('\n') : '';
}

function itemFinished(item: AnyRecord, turn: AnyRecord): boolean {
  return turn.status !== 'inProgress' || Boolean(turn.completedItemIds?.[item.id]) ||
    ['completed', 'failed', 'declined'].includes(item.status);
}

function itemMessages(item: AnyRecord, turn: AnyRecord, sessionId: string): NormalizedMessage[] {
  if (!item.id) return [];
  const base = {
    id: String(item.id), sessionId, provider: 'codex' as const,
    timestamp: new Date(turn.turnStartedAtMs || Date.now()).toISOString(),
  };
  if (item.type === 'agentMessage') {
    return item.text ? [createNormalizedMessage({ ...base, kind: 'text', role: 'assistant', content: item.text })] : [];
  }
  if (item.type === 'userMessage' || item.type === 'steeringUserMessage') {
    const parsed = parseFilesInputTag(inputText(item.content));
    const images = Array.isArray(item.content) ? item.content.filter((part: AnyRecord) =>
      part.type === 'localImage' || part.type === 'local_image').map((part: AnyRecord) => ({ path: part.path })) : [];
    return [createNormalizedMessage({
      ...base, kind: 'text', role: 'user', content: parsed.text,
      files: parsed.attachments.length ? parsed.attachments : undefined,
      images: images.length ? images : undefined,
    })];
  }
  if (item.type === 'reasoning') {
    const content = inputText(item.summary) || inputText(item.content);
    return content ? [createNormalizedMessage({ ...base, kind: 'thinking', content })] : [];
  }
  if (item.type === 'commandExecution') {
    return [createNormalizedMessage({
      ...base, kind: 'tool_use', toolId: base.id, toolName: 'Bash',
      toolInput: { command: item.command },
      toolResult: itemFinished(item, turn)
        ? { content: item.aggregatedOutput || '', isError: Boolean(item.exitCode) || item.status === 'failed' }
        : undefined,
      status: item.status,
    })];
  }
  if (item.type === 'fileChange' || item.type === 'mcpToolCall' || item.type === 'webSearch') {
    const toolName = item.type === 'fileChange' ? 'FileChanges' : item.type === 'webSearch' ? 'WebSearch' : item.tool || 'MCP';
    return [createNormalizedMessage({
      ...base, kind: 'tool_use', toolId: base.id, toolName,
      toolInput: item.changes || item.arguments || { query: item.query },
      toolResult: itemFinished(item, turn)
        ? {
          content: typeof item.result === 'string' ? item.result : item.result || item.error ? JSON.stringify(item.result ?? item.error) : '',
          isError: Boolean(item.error) || item.status === 'failed' || item.status === 'declined',
        }
        : undefined,
      status: item.status,
    })];
  }
  return [];
}

function currentTurn(run: DesktopRun): AnyRecord | undefined {
  return turnsFromState(run.client.state || {}).find(turn =>
    turn.params?.clientUserMessageId === run.clientUserMessageId ||
    (run.turnId && turn.turnId === run.turnId));
}

function sessionActivity(client: DesktopThreadClient, sessionId: string): ProviderSessionActivity | null {
  if (client.error || !client.state) return null;
  const state = client.state;
  const turn = [...turnsFromState(state)].reverse().find(turn => turn.status === 'inProgress');
  if (!turn && state.threadRuntimeStatus?.type !== 'active') return null;
  const pending = Boolean(turn?.turnId) && (state.requests || []).some((request: AnyRecord) => request.params?.turnId === turn?.turnId);
  const item = [...(turn?.items || [])].reverse().find(item =>
    !turn?.completedItemIds?.[item.id] && !['completed', 'failed', 'declined'].includes(item.status));
  const labels: Record<string, string> = {
    reasoning: '正在思考…',
    commandExecution: '正在执行命令…',
    fileChange: '正在修改文件…',
    mcpToolCall: '正在调用工具…',
    webSearch: '正在搜索…',
  };
  return {
    sessionId, provider: 'codex', lastSeq: 0, canInterrupt: false,
    startedAt: turn?.turnStartedAtMs || client.connectedAt,
    statusText: pending ? '等待确认…' : labels[item?.type] || '正在回复…',
  };
}

function getSessionActivity(sessionId: string): ProviderSessionActivity | null {
  for (const client of observedClients.get(sessionId) || []) {
    const activity = sessionActivity(client, sessionId);
    if (activity) return activity;
  }
  const run = runs.get(sessionId);
  return run ? sessionActivity(run.client, sessionId) : null;
}

function listRunningSessions(): ProviderSessionActivity[] {
  const ids = new Set([...observedClients.keys(), ...runs.keys()]);
  return [...ids].flatMap(id => {
    const activity = getSessionActivity(id);
    return activity ? [activity] : [];
  });
}

function updateApprovals(run: DesktopRun, writer: ProviderRuntimeWriter, sessionId: string) {
  const turn = currentTurn(run);
  const pendingIds = new Set<string>();
  for (const request of run.client.state?.requests || []) {
    if (request.params?.turnId !== turn?.turnId || !turn?.turnId) continue;
    const isCommand = request.method === 'item/commandExecution/requestApproval';
    if (!isCommand && request.method !== 'item/fileChange/requestApproval') continue;
    const requestId = 'codex-desktop:' + sessionId + ':' + request.id;
    pendingIds.add(requestId);
    if (approvals.has(requestId)) continue;
    const message = createNormalizedMessage({
      provider: 'codex', sessionId, kind: 'permission_request', requestId,
      toolName: isCommand ? 'Bash' : 'FileChanges',
      input: isCommand ? { command: request.params.command, cwd: request.params.cwd } : request.params,
      context: { reason: request.params.reason },
    });
    approvals.set(requestId, {
      run, writer, message, nativeRequestId: request.id,
      method: isCommand ? 'thread-follower-command-approval-decision' : 'thread-follower-file-approval-decision',
    });
    send(writer, message);
  }
  for (const [id, approval] of approvals) {
    if (approval.run === run && !pendingIds.has(id)) {
      approvals.delete(id);
      send(writer, createNormalizedMessage({ provider: 'codex', sessionId, kind: 'permission_cancelled', requestId: id }));
    }
  }
}

async function tryRun(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, threadId: string): Promise<boolean> {
  const sessionId = options.sessionId || threadId;
  const controller = new AbortController();
  connectingRuns.set(sessionId, controller);
  let client: DesktopThreadClient | null = null;
  let run: DesktopRun | null = null;
  let removeListener: (() => void) | undefined;
  let streamingItemId: string | null = null;
  try {
    client = await connectThread(threadId);
    if (controller.signal.aborted) return true;
    if (!client) return false;
    run = { client, controller, turnId: null, clientUserMessageId: randomUUID(), dispatched: false };
    const activeRun = run;
    runs.set(sessionId, run);
    const completedItems = new Set<string>();
    const streamedText = new Map<string, string>();
    const flushStream = () => {
      if (!streamingItemId) return;
      send(writer, createNormalizedMessage({ provider: 'codex', sessionId, kind: 'stream_end' }));
      streamingItemId = null;
    };
    const emitTurn = () => {
      if (activeRun.client.error) return;
      const turn = currentTurn(activeRun);
      if (!turn) return;
      if (turn.turnId) activeRun.turnId = turn.turnId;
      for (const item of turn.items || []) {
        if (completedItems.has(item.id)) continue;
        const completed = turn.status !== 'inProgress' || Boolean(turn.completedItemIds?.[item.id]);
        if (item.type === 'agentMessage' && typeof item.text === 'string') {
          const previous = streamedText.get(item.id) || '';
          if (item.text.startsWith(previous) && item.text.length > previous.length) {
            if (streamingItemId !== item.id) flushStream();
            streamingItemId = item.id;
            send(writer, createNormalizedMessage({
              provider: 'codex', sessionId, kind: 'stream_delta', content: item.text.slice(previous.length),
            }));
            streamedText.set(item.id, item.text);
          }
        }
        if (completed) {
          flushStream();
          completedItems.add(item.id);
          for (const message of itemMessages(item, turn, sessionId)) {
            // The websocket gateway already echoed this user's submitted prompt.
            if (message.role !== 'user') send(writer, message);
          }
        }
      }
      updateApprovals(activeRun, writer, sessionId);
    };
    removeListener = client.onState(emitTurn);
    const isIdle = (state: AnyRecord) => state.threadRuntimeStatus?.type !== 'active' &&
      !turnsFromState(state).some(turn => turn.status === 'inProgress');
    send(writer, createNormalizedMessage({
      provider: 'codex', sessionId, kind: 'status',
      text: isIdle(client.state || {}) ? '已连接电脑 Codex，沿用原对话上下文和权限' : '等待电脑当前回复完成后发送…',
    }));
    await client.waitFor(isIdle, run.controller.signal);
    if (controller.signal.aborted) return true;
    const prompt = appendFilesInputTag(command, options.files);
    // Desktop user input has a richer contract than SDK input. Its renderer
    // reads text_elements even when a plain text message has no placeholders.
    const input = buildCodexInputItems(prompt, options.images, client.state?.cwd).map(item =>
      item.type === 'text'
        ? { ...item, text_elements: [] }
        : { type: 'localImage', path: item.path });
    // Keep the desktop's managed permission profile and sandbox. Only a model
    // selection made by the user in CloudCLI is passed as a turn override.
    const request: AnyRecord = {
      threadId, input, clientUserMessageId: run.clientUserMessageId,
      model: typeof options.model === 'string' ? options.model : undefined,
      effort: typeof options.effort === 'string' && options.effort !== 'default' ? options.effort : undefined,
    };
    run.dispatched = true;
    await client.request('thread-follower-start-turn', {
      conversationId: threadId, turnStart: { request, context: { inheritThreadSettings: true } },
    }, 30000);
    send(writer, createNormalizedMessage({ provider: 'codex', sessionId, kind: 'status', text: '电脑 Codex 正在回复…' }));
    await client.waitFor(() => Boolean(currentTurn(activeRun)), run.controller.signal, 30000);
    await client.waitFor(() => {
      emitTurn();
      const turn = currentTurn(activeRun);
      return Boolean(turn && turn.status !== 'inProgress');
    }, run.controller.signal);
    flushStream();
    const turn = currentTurn(run);
    if (turn?.error) throw new Error(turn.error.message || String(turn.error));
    const tokenBudget = tokenBudgetFromState(client.state);
    if (tokenBudget) send(writer, createNormalizedMessage({
      provider: 'codex', sessionId, kind: 'status', text: 'token_budget', tokenBudget,
    }));
    send(writer, createCompleteMessage({
      provider: 'codex', sessionId, actualSessionId: threadId,
      exitCode: turn?.status === 'completed' ? 0 : 1,
      aborted: turn?.status === 'interrupted',
    }));
    return true;
  } catch (error) {
    // Once a desktop owner has been discovered, never retry via exec: the
    // desktop might already have accepted the prompt despite a timeout.
    if (!controller.signal.aborted) {
      if (streamingItemId) send(writer, createNormalizedMessage({ provider: 'codex', sessionId, kind: 'stream_end' }));
      send(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'error',
        content: '连接电脑 Codex 失败：' + (error instanceof Error ? error.message : String(error)),
      }));
      send(writer, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
    }
    return true;
  } finally {
    removeListener?.();
    if (connectingRuns.get(sessionId) === controller) connectingRuns.delete(sessionId);
    if (run) {
      if (runs.get(sessionId) === run) runs.delete(sessionId);
      for (const [id, approval] of approvals) if (approval.run === run) approvals.delete(id);
    }
    client?.close();
  }
}

async function abort(sessionId: string): Promise<boolean> {
  const run = runs.get(sessionId);
  if (!run) {
    const controller = connectingRuns.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }
  // Cancelling a queued phone message must not interrupt the desktop's
  // preceding turn. An interrupt is always pinned to the phone's own turn id.
  if (run.dispatched && !currentTurn(run)) {
    // The desktop may have received start-turn before publishing its turn id.
    // Wait for that id so Stop cannot accidentally target another user's turn.
    await run.client.waitFor(() => Boolean(currentTurn(run)), undefined, 30000);
  }
  const turn = currentTurn(run);
  if (turn?.turnId && turn.status === 'inProgress') {
    await run.client.request('thread-follower-interrupt-turn', {
      conversationId: run.client.threadId, expectedTurnId: turn.turnId, mode: 'user-stop',
    });
  }
  run.controller.abort();
  return true;
}

async function fetchHistory(threadId: string, sessionId: string, limit: number | null, offset: number): Promise<FetchHistoryResult | null> {
  const client = await connectThread(threadId);
  if (!client) return null;
  try {
    if (client.state?.turnHistory?.history?.isComplete !== true &&
      client.state?.turnsPagination?.hasLoadedOldest !== true) {
      const loaded = await client.request('thread-follower-load-complete-history', { conversationId: threadId }, 120000);
      const loadedRevision = loaded.result?.revision;
      if (typeof loadedRevision === 'number') {
        await client.waitFor(() => client.revision >= loadedRevision, undefined, 12000);
      }
    }
    const messages = turnsFromState(client.state || {}).flatMap(turn =>
      (turn.items || []).flatMap((item: AnyRecord) => itemMessages(item, turn, sessionId)));
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(messages, normalizedLimit, normalizedOffset);
    return {
      messages: page, total: messages.length, hasMore,
      offset: normalizedOffset, limit: normalizedLimit,
      tokenUsage: tokenBudgetFromState(client.state),
    };
  } finally { client.close(); }
}

function resolveApproval(requestId: string, decision: ProviderPermissionDecision) {
  const approval = approvals.get(requestId);
  if (!approval) return;
  if (currentTurn(approval.run)?.status !== 'inProgress') return;
  void approval.run.client.request(approval.method, {
    conversationId: approval.run.client.threadId,
    requestId: approval.nativeRequestId, decision: decision.allow ? 'accept' : 'decline',
  }).then(() => {
    if (approvals.get(requestId) === approval) approvals.delete(requestId);
    send(approval.writer, createNormalizedMessage({
      provider: 'codex', sessionId: approval.message.sessionId, kind: 'permission_cancelled', requestId,
    }));
  }).catch(error => {
    send(approval.writer, createNormalizedMessage({
      provider: 'codex', sessionId: approval.message.sessionId, kind: 'error',
      content: '电脑端确认失败：' + (error instanceof Error ? error.message : String(error)),
    }));
  });
}

async function watch(
  threadId: string,
  sessionId: string,
  writer: ProviderRuntimeWriter,
  isLocalRunActive: () => boolean,
  signal: AbortSignal,
  onStopped?: () => void,
): Promise<(() => void) | null> {
  const client = await connectThread(threadId);
  if (!client) return null;
  if (signal.aborted) { client.close(); return null; }
  const clients = observedClients.get(sessionId) || new Set<DesktopThreadClient>();
  clients.add(client);
  observedClients.set(sessionId, clients);
  const seen = new Set(turnsFromState(client.state || {}).flatMap(turn =>
    (turn.items || []).filter((item: AnyRecord) => itemFinished(item, turn)).map((item: AnyRecord) => item.id)));
  const watchRun: DesktopRun = {
    client, controller: new AbortController(), turnId: null, clientUserMessageId: '', dispatched: false,
  };
  let wasActive = false;
  let previousStatus = '';
  let stopped = false;
  let removeListener: () => void = () => undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    removeListener();
    signal.removeEventListener('abort', stop);
    clients.delete(client);
    if (!clients.size && observedClients.get(sessionId) === clients) observedClients.delete(sessionId);
    for (const [id, approval] of approvals) if (approval.run === watchRun) approvals.delete(id);
    client.close();
    onStopped?.();
  };
  const update = () => {
    if (stopped) return;
    const state = client.state || {};
    const turns = turnsFromState(state);
    // A phone-initiated run owns its sequenced stream. Observers only relay
    // desktop-initiated work so responses and completion events aren't doubled.
    if (client.error) {
      if (wasActive && !isLocalRunActive()) {
        send(writer, createNormalizedMessage({ provider: 'codex', sessionId, kind: 'error', content: client.error.message }));
        send(writer, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
      }
      stop();
      return;
    }
    if (isLocalRunActive()) {
      for (const turn of turns) for (const item of turn.items || []) seen.add(item.id);
      wasActive = false;
      previousStatus = '';
      return;
    }
    const activeTurn = [...turns].reverse().find(turn => turn.status === 'inProgress');
    const activity = sessionActivity(client, sessionId);
    const active = Boolean(activity);
    if (active) {
      watchRun.turnId = activeTurn?.turnId || null;
      const status = JSON.stringify([activity?.statusText, activity?.startedAt]);
      if (status !== previousStatus) {
        send(writer, createNormalizedMessage({
          provider: 'codex', sessionId, kind: 'status', text: activity?.statusText,
          startedAt: activity?.startedAt, canInterrupt: false,
        }));
        previousStatus = status;
      }
      updateApprovals(watchRun, writer, sessionId);
    }
    for (const turn of turns) for (const item of turn.items || []) {
      if (seen.has(item.id) || !itemFinished(item, turn)) continue;
      seen.add(item.id);
      for (const message of itemMessages(item, turn, sessionId)) {
        send(writer, message);
        // History may already contain this tool's unfinished input row. A
        // separate result id updates its badge without replacing that row.
        if (message.kind === 'tool_use' && message.toolResult) send(writer, createNormalizedMessage({
          provider: 'codex', sessionId, id: message.id + ':result', kind: 'tool_result',
          toolId: message.toolId, timestamp: message.timestamp,
          content: message.toolResult.content, isError: message.toolResult.isError,
        }));
      }
    }
    if (wasActive && !active) {
      updateApprovals(watchRun, writer, sessionId);
      const lastTurn = turns[turns.length - 1];
      const tokenBudget = tokenBudgetFromState(client.state);
      if (tokenBudget) send(writer, createNormalizedMessage({
        provider: 'codex', sessionId, kind: 'status', text: 'token_budget', tokenBudget,
      }));
      send(writer, createCompleteMessage({
        provider: 'codex', sessionId,
        exitCode: lastTurn?.status === 'failed' ? 1 : 0, aborted: lastTurn?.status === 'interrupted',
      }));
    }
    wasActive = active;
    if (!active) previousStatus = '';
  };
  removeListener = client.onState(update);
  signal.addEventListener('abort', stop, { once: true });
  update();
  return stop;
}

/**
 * Used by the Codex runtime/history adapter, running-session service, and WebSocket subscriptions to
 * follow a desktop-owned conversation through its existing local IPC owner.
 * No native ids or groups are replaced. Protocol errors prevent exec retries.
 */
export const codexDesktopBridge = {
  tryRun,
  abort,
  fetchHistory,
  watch,
  getSessionActivity,
  listRunningSessions,
  permissions: {
    resolve: resolveApproval,
    listPending: (sessionId: string) => [...approvals.values()]
      .filter(approval => approval.message.sessionId === sessionId).map(approval => approval.message),
  },
};
