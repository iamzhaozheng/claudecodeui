/** Shared contracts and helpers consumed by providers and WebSocket services. */
export type {
  AnyRecord,
  AuthenticatedWebSocketRequest,
  FetchHistoryOptions,
  FetchHistoryResult,
  LLMProvider,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderSessionActivity,
  ProviderRuntimeWriter,
  ProviderRuntimeContext,
} from './types.js';
export {
  AppError,
  createCompleteMessage,
  createNormalizedMessage,
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  generateMessageId,
  normalizeProjectPath,
  normalizeSessionName,
  parseIncomingJsonObject,
  readObjectRecord,
  readFileTimestamps,
  sliceTailPage,
  stripCodexAttachmentScaffolding,
} from './utils.js';
export {
  appendFilesInputTag,
  buildCodexInputItems,
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  parseFilesInputTag,
  toImageAttachments,
  toPosixPath,
} from './image-attachments.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
export type { IProviderRuntime, IProviderSessions, IProviderSessionSynchronizer } from './interfaces.js';
