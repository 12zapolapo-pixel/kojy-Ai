/**
 * @kojyai/engine/delegation — Public API
 *
 * Exports the Delegation agent orchestrator and its constituent stage
 * functions. Consumers (the delegation tRPC router and the BullMQ
 * delegation processor) import from this barrel.
 */

export { runDelegationAgent } from "./DelegationAgent.js";
export type {
  DelegationRunInput,
  DelegationRunResult,
  DelegationTaskStatus,
  StatusCallback,
} from "./DelegationAgent.js";

export { planFeatureRequest } from "./AgentPlanner.js";
export type { TaskPlan, PlannerInput } from "./AgentPlanner.js";

export { generateBotScript } from "./AgentCoder.js";
export type { CoderResult, BotScriptContext } from "./AgentCoder.js";

export {
  executeNaturalLanguageCases,
  executeStructuredScenarios,
  validateScriptStructure,
  checkScriptSafety,
  stripEsmExport,
} from "../runtime/ScriptSandbox.js";
export type {
  SandboxResult,
  NaturalLanguageTestCase,
  StructuredTestScenario,
  StructuredTestResult,
} from "../runtime/ScriptSandbox.js";

export { reflectAndFix, MAX_REFLECTION_RETRIES } from "./AgentReflection.js";
