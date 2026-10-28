/**
 * @kojyai/engine/runtime — Public barrel
 * Re-exports the Highrise Bot WebSocket client, the deterministic
 * Reactive Engine (moderation + reactivity + chat templates), and the
 * pluggable AI provider layer for conversational replies.
 * Consumers: apps/api/src/modules/bots/runtime-manager.ts
 */
export * from "./highrise-protocol.js";
export * from "./HighriseClient.js";
export * from "./ReactiveEngine.js";
export * from "./AIProvider.js";
export * from "./EmbeddingProvider.js";
