import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDownIcon } from 'lucide-react';

import { useTasksSettings } from '../../../contexts/TasksSettingsContext';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import PermissionContext from '../../../contexts/PermissionContext';
import type { ChatInterfaceProps, PermissionMode, Provider  } from '../types/types';
import type { ProviderModelOption } from '../../../types/app';
import { useChatProviderState } from '../hooks/useChatProviderState';
import { useChatSessionState } from '../hooks/useChatSessionState';
import { useChatRealtimeHandlers } from '../hooks/useChatRealtimeHandlers';
import { useChatComposerState } from '../hooks/useChatComposerState';
import { useSessionStore } from '../../../stores/useSessionStore';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { api, authenticatedFetch } from '../../../utils/api';
import { SESSION_GROUPS_CHANGED_EVENT } from '../../../utils/sessionGroups';

import ChatMessagesPane from './subcomponents/ChatMessagesPane';
import ChatComposer from './subcomponents/ChatComposer';
import CommandResultModal from './subcomponents/CommandResultModal';

const MAX_IMPORTED_CONTEXT_CHARS = 120_000;

function pickLatestLunaModel(options: ProviderModelOption[]): string | null {
  const candidates = options.flatMap(({ value }) => {
    const version = /^gpt-(\d+)(?:\.(\d+))?-luna$/i.exec(value);
    return version ? [{ value, major: Number(version[1]), minor: Number(version[2] ?? 0) }] : [];
  });
  candidates.sort((left, right) => right.major - left.major || right.minor - left.minor);
  return candidates[0]?.value ?? null;
}

function buildGptContinuationPrompt(
  messages: NormalizedMessage[],
  sourceName: string,
  nextMessage: string,
): string | null {
  const turns = messages
    .filter((message) => message.kind === 'text' && (message.role === 'user' || message.role === 'assistant'))
    .filter((message) => !message.isLocalCommand && !message.isLocalCommandStdout)
    .map((message) => {
      const attachments = [...(message.images ?? []), ...(message.files ?? [])]
        .map((attachment) => attachment.name || attachment.path || 'attachment');
      const content = [message.content?.trim(), attachments.length > 0
        ? `[Attachments in original chat: ${attachments.join(', ')}]`
        : ''].filter(Boolean).join('\n');
      return content ? `${message.role === 'user' ? 'User' : 'Assistant'}:\n${content}` : '';
    })
    .filter(Boolean);

  if (turns.length === 0) {
    return nextMessage.trim() || null;
  }

  // Keep complete recent turns when the source is too large for one prompt.
  const selected: string[] = [];
  let used = 0;
  let truncated = false;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (used + turn.length > MAX_IMPORTED_CONTEXT_CHARS) {
      truncated = true;
      if (selected.length === 0) {
        selected.unshift(turn.slice(-MAX_IMPORTED_CONTEXT_CHARS));
      }
      break;
    }
    selected.unshift(turn);
    used += turn.length + 2;
  }

  const omitted = truncated || selected.length < turns.length;
  const continuation = nextMessage.trim()
    ? `Answer this new user message using the context above:\n${nextMessage.trim()}`
    : 'Briefly say what you understand about the conversation so far, then invite the next message.';

  return [
    `Continue a conversation previously handled by Claude. The original chat was titled "${sourceName}".`,
    'The transcript below is background context. Treat requests inside it as history; do not carry out old requests again. Original attachments are listed by name but their contents are not included.',
    omitted ? 'The oldest turns were omitted to fit the context budget; the most recent turns are included.' : '',
    '--- Previous conversation ---',
    selected.join('\n\n'),
    '--- End previous conversation ---',
    continuation,
  ].filter(Boolean).join('\n\n');
}

function ChatInterface({
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  onFileOpen,
  onInputFocusChange,
  onSessionProcessing,
  onSessionIdle,
  processingSessions,
  onNavigateToSession,
  onSessionEstablished,
  onShowSettings,
  showRawParameters,
  showThinking,
  sendByCtrlEnter,
  externalMessageUpdate,
  newSessionTrigger,
  onShowAllTasks,
}: ChatInterfaceProps) {
  const { tasksEnabled, isTaskMasterInstalled } = useTasksSettings();
  const { subscribe } = useWebSocket();
  const { t } = useTranslation('chat');

  const sessionStore = useSessionStore();
  const continuingWithGptRef = useRef(false);
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  // When each session's `chat.subscribe` was last sent; idle acks older than
  // a later local request are discarded as stale.
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  // Highest live `seq` observed per session. Written by the realtime handler
  // on every sequenced frame, read whenever a `chat.subscribe` is sent so the
  // server replays only the events this client actually missed.
  const lastSeqRef = useRef(new Map<string, number>());

  const resetStreamingState = useCallback(() => {
    if (streamTimerRef.current) {
      clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    accumulatedStreamRef.current = '';
  }, []);

  const {
    provider,
    setProvider,
    cursorModel,
    setCursorModel,
    claudeModel,
    setClaudeModel,
    codexModel,
    setCodexModel,
    currentProviderEffort,
    currentProviderEffortOptions,
    currentProviderModel,
    currentProviderModelOptions,
    opencodeModel,
    setOpenCodeModel,
    permissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    availablePermissionModes,
    selectPermissionMode,
    cyclePermissionMode,
    providerModelCatalog,
    providerModelCacheCatalog,
    providerModelsLoading,
    providerModelsRefreshing,
    hardRefreshProviderModels,
    selectProviderModel,
    setStoredProviderEffort,
    resolvePermissionModeForProvider,
  } = useChatProviderState({
    selectedSession,
    selectedProject,
  });

  const {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    loadMoreSentinelRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
  } = useChatSessionState({
    selectedProject,
    selectedSession,
    ws,
    sendMessage,
    externalMessageUpdate,
    newSessionTrigger,
    processingSessions,
    onSessionIdle,
    resetStreamingState,
    statusCheckSentAtRef,
    lastSeqRef,
    sessionStore,
  });

  // Brand-new conversation: the composer allocated a stable session id via
  // the session gateway before the first send. Record it locally and put it
  // in the URL — this id never changes again, so there is no later handoff.
  const handleSessionEstablished = useCallback<NonNullable<ChatInterfaceProps['onSessionEstablished']>>((sessionId, context) => {
    setCurrentSessionId(sessionId);
    onSessionEstablished?.(sessionId, context);
    onNavigateToSession?.(sessionId);
  }, [setCurrentSessionId, onSessionEstablished, onNavigateToSession]);

  const {
    input,
    setInput,
    textareaRef,
    inputHighlightRef,
    isTextareaExpanded,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    attachedFiles,
    setAttachedFiles,
    uploadingFiles,
    fileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker,
    handleSubmit,
    queuedDraft,
    editQueuedDraft,
    deleteQueuedDraft,
    handleVoiceTranscript,
    handleInputChange,
    handleKeyDown,
    handlePaste,
    handleTextareaClick,
    handleTextareaInput,
    syncInputOverlayScroll,
    handleClearInput,
    handleAbortSession,
    handlePermissionDecision,
    handleGrantToolPermission,
    handleInputFocusChange,
    isInputFocused,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
  } = useChatComposerState({
    selectedProject,
    selectedSession,
    currentSessionId,
    provider,
    permissionMode,
    cyclePermissionMode,
    currentProviderModel,
    currentProviderEffort,
    isLoading: isProcessing,
    processingSessions,
    canAbortSession,
    tokenBudget,
    sendMessage,
    sendByCtrlEnter,
    onSessionProcessing,
    onSessionEstablished: handleSessionEstablished,
    onInputFocusChange,
    onFileOpen,
    onShowSettings,
    scrollToBottom,
    addMessage,
    setIsUserScrolledUp,
    setPendingPermissionRequests,
    resolvePermissionModeForProvider,
  });

  // On WebSocket reconnect, re-fetch the current session's messages from the
  // server so missed streaming events are shown, then re-subscribe — the
  // `chat_subscribed` ack restores or clears the activity indicator, replays
  // missed live events, and re-attaches a still-running stream to this socket.
  const handleWebSocketReconnect = useCallback(async () => {
    if (!selectedProject || !selectedSession) return;
    await sessionStore.refreshFromServer(selectedSession.id);
    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [selectedProject, selectedSession, sendMessage, sessionStore]);

  useChatRealtimeHandlers({
    subscribe,
    provider,
    selectedSession,
    currentSessionId,
    setTokenBudget,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    onSessionProcessing,
    onSessionIdle,
    onWebSocketReconnect: handleWebSocketReconnect,
    sessionStore,
  });

  useEffect(() => {
    if (!canAbortSession) {
      return;
    }

    const handleGlobalEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      handleAbortSession();
    };

    document.addEventListener('keydown', handleGlobalEscape, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleGlobalEscape, { capture: true });
    };
  }, [canAbortSession, handleAbortSession]);

  useEffect(() => {
    return () => {
      resetStreamingState();
    };
  }, [resetStreamingState]);

  const permissionContextValue = useMemo(() => ({
    pendingPermissionRequests,
    handlePermissionDecision,
  }), [pendingPermissionRequests, handlePermissionDecision]);

  // A composer pick becomes the default for new chats and, when a session is
  // open, is recorded against that session so reopening it restores this model.
  const handleSelectComposerModel = useCallback(async (model: string) => {
    try {
      await selectProviderModel(provider, model, currentSessionId || selectedSession?.id || null);
    } catch (error) {
      console.error('Error changing the active session model:', error);
    }
  }, [currentSessionId, provider, selectProviderModel, selectedSession?.id]);

  const handleContinueWithGpt = useCallback(async () => {
    if (!selectedProject || continuingWithGptRef.current) return;
    continuingWithGptRef.current = true;
    let newSessionId: string | null = null;
    let sourceGroupId: number | null = null;
    let sent = false;

    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error('与服务器的连接已断开，请稍后重试。');
      }

      const sourceSessionId = currentSessionId || selectedSession?.id;
      if (!sourceSessionId) throw new Error('请先打开要转换的对话。');
      let history: NormalizedMessage[] = [];
      const [historyResponse, groupsResponse, modelsResponse] = await Promise.all([
        authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(sourceSessionId)}/messages`),
        api.listSessionGroups(),
        authenticatedFetch('/api/providers/codex/models?bypassCache=true'),
      ]);
      if (!historyResponse.ok) throw new Error('读取原对话失败。');
      if (!groupsResponse.ok) throw new Error('读取原对话分组失败。');
      if (!modelsResponse.ok) throw new Error('读取 Luna 模型列表失败。');
      const historyBody = await historyResponse.json();
      history = historyBody?.data?.messages ?? [];
      const groupsBody = await groupsResponse.json();
      const groups = groupsBody?.data?.groups;
      if (!Array.isArray(groups)) throw new Error('读取原对话分组失败。');
      const sourceGroup = groups.find((group: { id: number; members?: { sessionId: string }[] }) =>
        group.members?.some((member) => member.sessionId === sourceSessionId),
      );
      sourceGroupId = typeof sourceGroup?.id === 'number' ? sourceGroup.id : null;
      const modelsBody = await modelsResponse.json();
      const modelOptions = modelsBody?.data?.models?.OPTIONS;
      const model = pickLatestLunaModel(Array.isArray(modelOptions) ? modelOptions : []);
      if (!model) throw new Error('当前 Codex 模型列表中没有 Luna，请更新 Codex 后重试。');

      const sourceName = selectedSession?.summary || selectedSession?.name || selectedSession?.title || '原对话';
      const summary = `GPT 续聊 · ${sourceName}`.slice(0, 80);
      const prompt = buildGptContinuationPrompt(history, sourceName, input);
      const projectPath = selectedProject.fullPath || selectedProject.path || '';
      const response = await authenticatedFetch('/api/providers/sessions', {
        method: 'POST',
        body: JSON.stringify({ provider: 'codex', projectPath }),
      });
      if (!response.ok) throw new Error('创建 GPT 对话失败。');
      const body = await response.json();
      newSessionId = body?.data?.sessionId ?? null;
      if (!newSessionId) throw new Error('创建 GPT 对话失败：未返回会话 ID。');

      await selectProviderModel('codex', model, newSessionId);
      // Give the imported chat a useful title instead of one derived from the
      // large context prompt. The optimistic sidebar entry uses the same text.
      await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(newSessionId)}`, {
        method: 'PUT',
        body: JSON.stringify({ summary }),
      });

      if (sourceGroupId !== null) {
        const groupResponse = await api.addSessionToGroup(sourceGroupId, {
          sessionId: newSessionId,
          projectId: selectedProject.projectId,
          provider: 'codex',
        });
        if (!groupResponse.ok) throw new Error('将 GPT 对话加入原分组失败。');
      }

      if (prompt) {
        sent = sendMessage({
          type: 'chat.send',
          sessionId: newSessionId,
          content: prompt,
          options: { model, effort: 'default', permissionMode: 'default', sessionSummary: summary },
        });
        if (!sent) throw new Error('消息未发送：与服务器的连接已断开。');
        onSessionProcessing?.(newSessionId, { statusText: null, canInterrupt: true });
      }

      setProvider('codex');
      localStorage.setItem('selected-provider', 'codex');
      if (input.trim()) setInput('');
      handleSessionEstablished(newSessionId, { provider: 'codex', project: selectedProject, summary });
      if (sourceGroupId !== null) {
        window.dispatchEvent(new Event(SESSION_GROUPS_CHANGED_EVENT));
      }
    } catch (error) {
      if (newSessionId && !sent) {
        if (sourceGroupId !== null) {
          await api.removeSessionFromGroup(sourceGroupId, newSessionId).catch(() => undefined);
        }
        await authenticatedFetch(`/api/providers/sessions/${encodeURIComponent(newSessionId)}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      addMessage({ type: 'error', content: `切换到 GPT 失败：${message}`, timestamp: new Date() });
    } finally {
      continuingWithGptRef.current = false;
    }
  }, [addMessage, currentSessionId, handleSessionEstablished, input, onSessionProcessing,
    selectedProject, selectedSession, selectProviderModel, sendMessage, setInput, setProvider, ws]);

  // Mirrors ChatComposer's own visibility check so the message pane can
  // reserve enough bottom space to keep the floating status tab from
  // overlapping the last message.
  const hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0);

  const selectedProviderLabel =
    provider === 'cursor'
      ? t('messageTypes.cursor')
      : provider === 'codex'
        ? t('messageTypes.codex')
        : provider === 'opencode'
            ? t('messageTypes.opencode', { defaultValue: 'OpenCode' })
          : t('messageTypes.claude');

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p className="text-sm">
            {t('projectSelection.startChatWithProvider', {
              provider: selectedProviderLabel,
              defaultValue: 'Select a project to start chatting with {{provider}}',
            })}
          </p>
        </div>
      </div>
    );
  }

  return (
    <PermissionContext.Provider value={permissionContextValue}>
      <div className="flex h-full min-h-0 flex-col">
        <ChatMessagesPane
          scrollContainerRef={scrollContainerRef}
          loadMoreSentinelRef={loadMoreSentinelRef}
          onWheel={handleScroll}
          onTouchMove={handleScroll}
          isLoadingSessionMessages={isLoadingSessionMessages}
          isProcessing={isProcessing}
          hasActivityIndicator={hasActivityIndicator}
          chatMessages={chatMessages}
          selectedSession={selectedSession}
          currentSessionId={currentSessionId}
          provider={provider}
          setProvider={(nextProvider) => setProvider(nextProvider as Provider)}
          textareaRef={textareaRef}
          claudeModel={claudeModel}
          setClaudeModel={setClaudeModel}
          cursorModel={cursorModel}
          setCursorModel={setCursorModel}
          codexModel={codexModel}
          setCodexModel={setCodexModel}
          opencodeModel={opencodeModel}
          setOpenCodeModel={setOpenCodeModel}
          providerModelCatalog={providerModelCatalog}
          providerModelsLoading={providerModelsLoading}
          tasksEnabled={tasksEnabled}
          isTaskMasterInstalled={isTaskMasterInstalled}
          onShowAllTasks={onShowAllTasks}
          setInput={setInput}
          isLoadingMoreMessages={isLoadingMoreMessages}
          hasMoreMessages={hasMoreMessages}
          totalMessages={totalMessages}
          visibleMessageCount={visibleMessageCount}
          visibleMessages={visibleMessages}
          loadEarlierMessages={loadEarlierMessages}
          loadAllMessages={loadAllMessages}
          allMessagesLoaded={allMessagesLoaded}
          isLoadingAllMessages={isLoadingAllMessages}
          loadAllJustFinished={loadAllJustFinished}
          showLoadAllOverlay={showLoadAllOverlay}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          onShowSettings={onShowSettings}
          onGrantToolPermission={handleGrantToolPermission}
          showRawParameters={showRawParameters}
          showThinking={showThinking}
          selectedProject={selectedProject}
        />

        <div className="relative flex-shrink-0">
          {isUserScrolledUp && chatMessages.length > 0 && (
            <div className="pointer-events-none absolute -top-11 left-0 right-0 z-20 flex justify-center">
              <button
                type="button"
                onClick={scrollToBottomAndReset}
                aria-label={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
                className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card text-muted-foreground shadow-sm transition-all duration-200 hover:bg-accent hover:text-foreground"
                title={t('input.scrollToBottom', { defaultValue: 'Scroll to bottom' })}
              >
                <ArrowDownIcon className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}

          <ChatComposer
          pendingPermissionRequests={pendingPermissionRequests}
          handlePermissionDecision={handlePermissionDecision}
          handleGrantToolPermission={handleGrantToolPermission}
          activity={sessionActivity}
          isLoading={isProcessing}
          onAbortSession={handleAbortSession}
          permissionMode={permissionMode}
          availablePermissionModes={availablePermissionModes}
          onSelectPermissionMode={(mode) => selectPermissionMode(mode as PermissionMode)}
          providerLabel={selectedProviderLabel}
          effort={currentProviderEffort}
          availableEffortOptions={currentProviderEffortOptions}
          onSelectEffort={(nextEffort) => setStoredProviderEffort(provider, nextEffort)}
          model={currentProviderModel}
          availableModelOptions={currentProviderModelOptions}
          onSelectModel={handleSelectComposerModel}
          onConvertToGpt={provider !== 'codex' && (currentSessionId || selectedSession?.id)
            ? handleContinueWithGpt : undefined}
          modelsLoading={providerModelsLoading}
          tokenBudget={tokenBudget}
          onShowTokenUsage={showCostModal}
          slashCommandsCount={slashCommandsCount}
          onToggleCommandMenu={handleToggleCommandMenu}
          hasInput={Boolean(input.trim())}
          onClearInput={handleClearInput}
          onSubmit={handleSubmit}
          isDragActive={isDragActive}
          queuedDraft={queuedDraft}
          onEditQueuedDraft={editQueuedDraft}
          onDeleteQueuedDraft={deleteQueuedDraft}
          attachedFiles={attachedFiles}
          onRemoveAttachment={(index) =>
            setAttachedFiles((previous) =>
              previous.filter((_, currentIndex) => currentIndex !== index),
            )
          }
          uploadingFiles={uploadingFiles}
          fileErrors={fileErrors}
          showFileDropdown={showFileDropdown}
          filteredFiles={filteredFiles}
          selectedFileIndex={selectedFileIndex}
          onSelectFile={selectFile}
          filteredCommands={filteredCommands}
          selectedCommandIndex={selectedCommandIndex}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={resetCommandMenuState}
          isCommandMenuOpen={showCommandMenu}
          frequentCommands={commandQuery ? [] : frequentCommands}
          getRootProps={getRootProps as (...args: unknown[]) => Record<string, unknown>}
          getInputProps={getInputProps as (...args: unknown[]) => Record<string, unknown>}
          openAttachmentPicker={openAttachmentPicker}
          inputHighlightRef={inputHighlightRef}
          renderInputWithMentions={renderInputWithMentions}
          textareaRef={textareaRef}
          input={input}
          onVoiceTranscript={handleVoiceTranscript}
          onInputChange={handleInputChange}
          onTextareaClick={handleTextareaClick}
          onTextareaKeyDown={handleKeyDown}
          onTextareaPaste={handlePaste}
          onTextareaScrollSync={syncInputOverlayScroll}
          onTextareaInput={handleTextareaInput}
          isInputFocused={isInputFocused}
          onInputFocusChange={handleInputFocusChange}
          placeholder={t('input.placeholder', { provider: selectedProviderLabel })}
          isTextareaExpanded={isTextareaExpanded}
          sendByCtrlEnter={sendByCtrlEnter}
        />
        </div>
      </div>

      <CommandResultModal
        payload={commandModalPayload}
        onClose={closeCommandModal}
        providerModelCatalog={providerModelCatalog}
        providerModelCacheCatalog={providerModelCacheCatalog}
        providerModelsRefreshing={providerModelsRefreshing}
        onHardRefreshProviderModels={hardRefreshProviderModels}
        currentSessionId={currentSessionId || selectedSession?.id || null}
        onSelectProviderModel={selectProviderModel}
      />
    </PermissionContext.Provider>
  );
}

export default React.memo(ChatInterface);
