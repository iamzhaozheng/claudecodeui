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
  parseIncomingJsonObject,
  sliceTailPage,
} from './utils.js';
export {
  appendFilesInputTag,
  buildCodexInputItems,
  getGlobalImageAssetsDir,
  isImageAttachmentDescriptor,
  normalizeAttachmentDescriptors,
  parseFilesInputTag,
} from './image-attachments.js';
export type { ChatAttachmentDescriptor } from './image-attachments.js';
