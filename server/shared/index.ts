/** Shared contracts and message/attachment helpers used by provider adapters. */
export type {
  AnyRecord,
  FetchHistoryResult,
  NormalizedMessage,
  ProviderPermissionDecision,
  ProviderRuntimeWriter,
} from './types.js';
export {
  createCompleteMessage,
  createNormalizedMessage,
  sliceTailPage,
} from './utils.js';
export {
  appendFilesInputTag,
  buildCodexInputItems,
  parseFilesInputTag,
} from './image-attachments.js';
