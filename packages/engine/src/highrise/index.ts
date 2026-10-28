/**
 * @kojyai/engine/highrise — Public API
 *
 * Exports the Highrise Bot Orchestrator, all pipeline types,
 * the knowledge base, and template data.
 *
 * Frontend uses types only (import type).
 * Backend uses both types and implementations.
 */

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export { runHighriseOrchestrator } from "./HighriseOrchestrator.js";

export type {
  PipelineStage,
  ComposerStageEvent,
  ComposerArtifact,
  HighriseBotSpec,
  HighriseEvent,
  ProjectFile,
  TestResult,
  OrchestratorInput,
  OrchestratorResult,
  StageCallback,
} from "./HighriseOrchestrator.js";

export { MAX_FIX_RETRIES } from "./HighriseOrchestrator.js";

// ─── Knowledge Base ───────────────────────────────────────────────────────────

export {
  HIGHRISE_SDK_EVENTS,
  HIGHRISE_SDK_ACTIONS,
  HIGHRISE_BOT_TEMPLATES,
  HIGHRISE_TEST_EVENTS,
  HIGHRISE_BOT_TEMPLATE_PYTHON,
  REQUIREMENTS_TXT_TEMPLATE,
  STARTBOT_BAT_TEMPLATE,
  STARTBOT_SH_TEMPLATE,
  ENV_EXAMPLE_TEMPLATE,
  README_TEMPLATE,
} from "./HighriseKnowledge.js";
