import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import readline from 'node:readline';

import spawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag, buildCodexInputItems, createCompleteMessage, createNormalizedMessage,
} from '@/shared/index.js';
import type {
  AnyRecord, IProviderRuntime, NormalizedMessage, ProviderPermissionDecision,
  ProviderRuntimeContext, ProviderRuntimeWriter,
} from '@/shared/index.js';

type PendingRpc = {
  resolve(result: AnyRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type BackgroundRun = {
  client: BackgroundCodexClient;
  writer: ProviderRuntimeWriter;
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  aborted: boolean;
};
type PendingApproval = {
  run: BackgroundRun;
  nativeId: string | number;
  method: string;
  params: AnyRecord;
  message: NormalizedMessage;
};

const runs = new Map<string, BackgroundRun>();
const approvals = new Map<string, PendingApproval>();
const moduleRequire = createRequire(import.meta.url);

/** A private stdio process owned by CloudCLI, without desktop IPC or remote pairing. */
class BackgroundCodexClient {
  private child;
  private lines;
  private nextId = 0;
  private pending = new Map<number, PendingRpc>();
  private failure: Error | null = null;
  private closing = false;
  private stderr = '';
  private finishClosed!: (error: Error) => void;
  readonly closed = new Promise<Error>(resolve => { this.finishClosed = resolve; });

  constructor(cwd: string, onMessage: (message: AnyRecord) => void) {
    // Use the CLI installed alongside the SDK, including its native runtime
    // paths. A launch agent's PATH need not contain the desktop app's CLI.
    const override = process.env.CLOUDCLI_CODEX_PATH;
    const command = override || process.execPath;
    const args = override ? [] : [moduleRequire.resolve('@openai/codex/bin/codex.js')];
    this.child = spawn(command, [...args, 'app-server', '--stdio'], {
      cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin!.on('error', error => this.fail(error));
    this.child.stderr!.on('data', data => { this.stderr = (this.stderr + String(data)).slice(-4000); });
    this.child.on('close', code => this.fail(new Error(
      `CloudCLI 后台 Codex 已退出（${code ?? 'signal'}）` + (this.stderr ? `：${this.stderr.trim()}` : ''),
    )));
    this.lines = readline.createInterface({ input: this.child.stdout! });
    this.lines.on('line', line => {
      try {
        const message = JSON.parse(line) as AnyRecord;
        if (!message.method && typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
          else pending.resolve(message.result || {});
        } else onMessage(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        this.close();
      }
    });
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.finishClosed(error);
  }

  write(message: AnyRecord) {
    if (this.failure) throw this.failure;
    this.child.stdin!.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params: AnyRecord, timeoutMs = 90000): Promise<AnyRecord> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`等待 CloudCLI 后台 Codex 超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    this.fail(new Error('CloudCLI 后台 Codex 连接已结束'));
    this.lines.close();
    this.child.stdin!.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // Stdio EOF lets app-server flush thread persistence before exit.
      // Signal only when graceful shutdown fails to finish promptly.
      const terminateTimer = setTimeout(() => this.child.kill('SIGTERM'), 1500);
      const killTimer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      }, 4000);
      terminateTimer.unref();
      killTimer.unref();
      this.child.once('close', () => { clearTimeout(terminateTimer); clearTimeout(killTimer); });
    }
  }
}

function send(writer: ProviderRuntimeWriter, message: NormalizedMessage) {
  writer.send(writer.isSSEStreamWriter || writer.isWebSocketWriter ? message : JSON.stringify(message));
}

function cancelApproval(id: string, approval: PendingApproval) {
  approvals.delete(id);
  send(approval.run.writer, createNormalizedMessage({
    provider: 'codex', sessionId: approval.run.sessionId, kind: 'permission_cancelled', requestId: id,
  }));
}

function requestApproval(run: BackgroundRun, request: AnyRecord) {
  const params = request.params || {};
  // Subagent approvals share this transport and must reach the browser too.
  const names: Record<string, string> = {
    'item/commandExecution/requestApproval': 'Bash',
    'item/fileChange/requestApproval': 'FileChanges',
    'item/permissions/requestApproval': 'Permissions',
    'item/tool/requestUserInput': 'AskUserQuestion',
  };
  const toolName = names[request.method];
  if (!toolName) {
    run.client.write({ id: request.id, error: { code: -32601, message: `CloudCLI does not support ${request.method}` } });
    return;
  }
  const requestId = `codex-background:${run.sessionId}:${request.id}`;
  const input = toolName === 'AskUserQuestion'
    ? { questions: (params.questions || []).map((question: AnyRecord) => ({
      ...question, options: question.options || [], multiSelect: false,
    })) }
    : params;
  const message = createNormalizedMessage({
    provider: 'codex', sessionId: run.sessionId, kind: 'permission_request', requestId,
    toolName, input, context: { reason: params.reason },
  });
  approvals.set(requestId, { run, nativeId: request.id, method: request.method, params, message });
  send(run.writer, message);
  send(run.writer, createNormalizedMessage({ provider: 'codex', sessionId: run.sessionId, kind: 'status', text: '等待确认…' }));
}

function resolveApproval(requestId: string, decision: ProviderPermissionDecision) {
  const approval = approvals.get(requestId);
  if (!approval) return;
  let result: AnyRecord;
  if (approval.method === 'item/tool/requestUserInput') {
    const answers = (decision.updatedInput as AnyRecord)?.answers || {};
    result = { answers: Object.fromEntries((approval.params.questions || []).map((question: AnyRecord) => [
      question.id, { answers: decision.allow && typeof answers[question.question] === 'string' ? [answers[question.question]] : [] },
    ])) };
  } else if (approval.method === 'item/permissions/requestApproval') {
    result = { permissions: decision.allow ? approval.params.permissions : {}, scope: 'turn' };
  } else {
    // A generic remember entry must not grant unrestricted session permission.
    result = { decision: decision.allow ? 'accept' : 'decline' };
  }
  try {
    approval.run.client.write({ id: approval.nativeId, result });
    cancelApproval(requestId, approval);
    send(approval.run.writer, createNormalizedMessage({
      provider: 'codex', sessionId: approval.run.sessionId, kind: 'status', text: '后台 Codex 正在执行…',
    }));
  } catch (error) {
    console.warn('[CodexBackground] Approval response failed:', error);
  }
}

function serializeOutput(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
}

function toolMessage(item: AnyRecord, sessionId: string, completed: boolean): NormalizedMessage | null {
  let toolName: string;
  let input: unknown;
  let output: unknown;
  let isError = item.status === 'failed' || item.status === 'declined';
  switch (item.type) {
    case 'commandExecution':
      toolName = 'Bash'; input = { command: item.command, cwd: item.cwd };
      output = item.aggregatedOutput; isError ||= Boolean(item.exitCode); break;
    case 'fileChange':
      toolName = 'FileChanges'; input = item.changes; output = item.changes; break;
    case 'mcpToolCall':
      toolName = item.tool || 'MCP'; input = item.arguments;
      output = item.result ?? item.error; isError ||= Boolean(item.error); break;
    case 'webSearch':
      toolName = 'WebSearch'; input = item.action || { query: item.query }; output = item.action; break;
    case 'collabAgentToolCall':
      toolName = item.tool || 'Task'; input = { prompt: item.prompt }; output = item.agentsStates; break;
    case 'dynamicToolCall':
      toolName = item.tool; input = item.arguments; output = item.contentItems; isError ||= item.success === false; break;
    default: return null;
  }
  return createNormalizedMessage({
    provider: 'codex', sessionId, id: completed ? item.id + '-result' : item.id,
    kind: completed ? 'tool_result' : 'tool_use', toolId: item.id, toolName,
    toolInput: input, content: completed ? serializeOutput(output) : undefined,
    isError: completed ? isError : undefined, status: item.status,
  });
}

/** Providers runs turns on its own CLI process; desktop ownership triggers a native history fork. */
async function queryCodex(command: string, options: AnyRecord, writer: ProviderRuntimeWriter, context: ProviderRuntimeContext) {
  const sessionId = options.sessionId || randomUUID();
  const cwd = options.cwd || options.projectPath || process.cwd();
  let run: BackgroundRun | undefined;
  let streamItemId: string | null = null;
  let finishTurn!: (turn: AnyRecord) => void;
  const completedTurn = new Promise<AnyRecord>(resolve => { finishTurn = resolve; });
  const streamedText = new Map<string, string>();
  const completedItems = new Set<string>();
  const emit = (message: AnyRecord & { kind: NormalizedMessage['kind'] }) =>
    send(writer, createNormalizedMessage({ provider: 'codex', sessionId, ...message }));
  const endStream = () => {
    if (streamItemId) { emit({ kind: 'stream_end' }); streamItemId = null; }
  };
  const delta = (itemId: string, text: string) => {
    if (!text) return;
    if (streamItemId !== itemId) endStream();
    streamItemId = itemId;
    streamedText.set(itemId, (streamedText.get(itemId) || '') + text);
    emit({ kind: 'stream_delta', content: text });
  };

  try {
    const client = new BackgroundCodexClient(cwd, message => {
      if (!run) return;
      if (message.method && message.id !== undefined) {
        requestApproval(run, message);
        return;
      }
      const params = message.params || {};
      // Only the primary turn owns the composer stream and terminal completion.
      if (params.threadId && params.threadId !== run.threadId) return;
      if (params.turnId && run.turnId && params.turnId !== run.turnId) return;
      switch (message.method) {
        case 'turn/started':
          run.turnId = params.turn?.id || run.turnId;
          emit({ kind: 'status', text: '后台 Codex 正在回复…' }); break;
        case 'item/agentMessage/delta': delta(params.itemId, params.delta || ''); break;
        case 'item/started': {
          const item = params.item;
          if (!item) break;
          const labels: Record<string, string> = {
            reasoning: '正在思考…', commandExecution: '正在执行命令…', fileChange: '正在修改文件…',
            mcpToolCall: '正在调用工具…', webSearch: '正在搜索…',
          };
          emit({ kind: 'status', text: labels[item.type] || '后台 Codex 正在回复…' });
          if (item.type !== 'agentMessage') endStream();
          const tool = toolMessage(item, sessionId, false);
          if (tool) send(writer, tool);
          break;
        }
        case 'item/completed': {
          const item = params.item;
          if (!item || completedItems.has(item.id)) break;
          completedItems.add(item.id);
          if (item.type === 'agentMessage') {
            const previous = streamedText.get(item.id) || '';
            if (typeof item.text === 'string' && item.text.startsWith(previous)) delta(item.id, item.text.slice(previous.length));
            endStream();
            if (item.text) emit({ kind: 'text', id: item.id, role: 'assistant', content: item.text });
          } else if (item.type === 'reasoning') {
            const text = [...(item.summary || []), ...(item.content || [])].join('\n');
            if (text) emit({ kind: 'thinking', id: item.id, content: text });
          } else {
            const tool = toolMessage(item, sessionId, true);
            if (tool) send(writer, tool);
          }
          break;
        }
        case 'thread/tokenUsage/updated': {
          const usage = params.tokenUsage;
          if (usage) emit({ kind: 'status', text: 'token_budget', tokenBudget: {
            used: usage.total?.totalTokens || 0, total: usage.modelContextWindow || 200000,
            inputTokens: usage.total?.inputTokens || 0, outputTokens: usage.total?.outputTokens || 0,
          } });
          break;
        }
        case 'serverRequest/resolved': {
          for (const [id, approval] of approvals) {
            if (approval.run === run && approval.nativeId === params.requestId) cancelApproval(id, approval);
          }
          break;
        }
        case 'turn/completed': endStream(); finishTurn(params.turn || {}); break;
        case 'error':
          emit({ kind: 'status', text: params.willRetry ? '模型连接中断，后台正在重试…' : params.error?.message || '后台 Codex 遇到错误' });
          break;
      }
    });
    run = { client, writer, sessionId, threadId: null, turnId: null, aborted: false };
    runs.set(sessionId, run);
    emit({ kind: 'status', text: '正在启动 CloudCLI 后台 Codex…' });
    const model = await context.resolveResumeModel(options.sessionId, options.model);
    const catalog = await context.getProviderModels();
    const allowedEfforts = catalog.OPTIONS.find(option => option.value === model)?.effort?.values?.map(value => value.value) || [];
    const effort = allowedEfforts.includes(options.effort) ? options.effort : undefined;
    if (run.aborted) return;
    await client.request('initialize', { clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: '1.37.0' } }, 30000);
    client.write({ method: 'initialized', params: {} });
    const settings = {
      cwd, model, sandbox: options.permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: ['acceptEdits', 'bypassPermissions'].includes(options.permissionMode) ? 'never' : 'on-request',
    };
    const sourceId = context.resolveProviderSessionId(options.sessionId);
    let result: AnyRecord;
    if (sourceId) {
      emit({ kind: 'status', text: '正在读取原对话上下文…' });
      try {
        result = await client.request('thread/resume', { threadId: sourceId, excludeTurns: true, ...settings });
      } catch (error) {
        // No prompt has been submitted. Only an explicit writer conflict is
        // safe to branch; a timeout must never resubmit user input.
        if (run.aborted || !/thread-store conflict:.*already has an active writer/i.test(String(error))) throw error;
        emit({ kind: 'status', text: '原对话被占用，正在复制上下文到独立后台…' });
        result = await client.request('thread/fork', { threadId: sourceId, excludeTurns: true, ...settings });
      }
    } else result = await client.request('thread/start', settings);
    const thread = result.thread;
    if (typeof thread?.id !== 'string') throw new Error('后台 Codex 未返回对话 ID');
    run.threadId = thread.id;
    if (writer.setSessionId) writer.setSessionId(thread.id);
    else emit({ kind: 'session_created', newSessionId: thread.id });
    if (typeof thread.path === 'string') sessionsDb.setSessionTranscriptPath(sessionId, thread.path);
    if (sourceId && sourceId !== thread.id) emit({
      kind: 'text', role: 'system', content: '已带上原对话上下文，转为 CloudCLI 独立后台续聊。分组保持不变；后续消息保存在续聊副本中。',
    });
    if (run.aborted) return;
    const prompt = appendFilesInputTag(command, options.files);
    const input = buildCodexInputItems(prompt, options.images, cwd).map(item =>
      item.type === 'text' ? { ...item, text_elements: [] } : { type: 'localImage', path: item.path });
    // A timeout after turn/start is ambiguous: never retry or fork again.
    const started = await client.request('turn/start', {
      threadId: thread.id, input, model, effort, clientUserMessageId: randomUUID(),
    });
    run.turnId = started.turn?.id || run.turnId;
    const turn = await Promise.race([completedTurn, client.closed.then(error => { throw error; })]);
    const aborted = run.aborted || turn.status === 'interrupted';
    if (turn.status === 'failed' || turn.error) throw new Error(turn.error?.message || '后台 Codex 执行失败');
    send(writer, createCompleteMessage({ provider: 'codex', sessionId, actualSessionId: thread.id, exitCode: 0, aborted }));
    if (!aborted) notifyRunStopped({ userId: writer.userId || null, provider: 'codex', sessionId, sessionName: options.sessionSummary, stopReason: 'completed' });
  } catch (error) {
    endStream();
    if (!run?.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[CodexBackground] Run failed:', message);
      emit({ kind: 'error', content: message });
      send(writer, createCompleteMessage({ provider: 'codex', sessionId, exitCode: 1 }));
      notifyRunFailed({ userId: writer.userId || null, provider: 'codex', sessionId, sessionName: options.sessionSummary, error });
    }
  } finally {
    for (const [id, approval] of approvals) if (approval.run === run) cancelApproval(id, approval);
    if (runs.get(sessionId) === run) runs.delete(sessionId);
    run?.client.close();
  }
}

/** Used by the Providers registry for independent execution and browser approvals. */
export const codexRuntime: IProviderRuntime = {
  run: queryCodex,
  async abort(sessionId) {
    const run = runs.get(sessionId);
    if (!run) return false;
    run.aborted = true;
    if (run.threadId && run.turnId) {
      try { await run.client.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }, 10000); }
      catch { run.client.close(); }
    } else run.client.close();
    return true;
  },
  permissions: {
    resolve: resolveApproval,
    listPending: sessionId => [...approvals.values()].filter(approval => approval.run.sessionId === sessionId).map(approval => approval.message),
  },
};
