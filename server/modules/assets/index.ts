// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
export { default as assetsRoutes } from './assets.routes.js';

// Codex provider history adapters use this to expose trusted local attachments
// through the existing authenticated image endpoint.
export { registerLocalImagePreview } from './services/image-assets.service.js';
