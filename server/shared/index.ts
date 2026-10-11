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
} from './types.js';
export {
  AppError,
  createCompleteMessage,
  createNormalizedMessage,
  generateMessageId,
  parseIncomingJsonObject,
  readObjectRecord,
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
export type { IProviderSessions } from './interfaces.js';
