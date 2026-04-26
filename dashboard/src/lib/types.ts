/**
 * Dashboard TypeScript interfaces — mirrors daemon IPC response shapes
 */

/** Per-session state from daemon */
export interface SessionState {
  name: string;
  type: "claude" | "daemon" | "service";
  status: string;
  uptime_start: string | null;
  restart_count: number;
  last_error: string | null;
  last_health_check: string | null;
  consecutive_failures: number;
  tmux_pid: number | null;
  rss_mb: number | null;
  activity: "active" | "idle" | "stopped" | "unknown" | null;
  suspended: boolean;
  auto_suspended: boolean;
  /** Last few lines of tmux pane output */
  last_output: string | null;
  /** Claude prompt state: "working" (mid-task) or "waiting" (at prompt) */
  claude_status: "working" | "waiting" | null;
  path: string | null;
  has_build_script: boolean;
  uptime: string | null;
  /** True when this session is defined in the user's operad.toml [[session]]. */
  from_config?: boolean;
}

/** Phantom process count (informational — killer is disabled) */
export interface ProcessCount {
  phantom_procs: number;
}

/** System memory */
export interface SystemMemory {
  total_mb: number;
  available_mb: number;
  swap_total_mb: number;
  swap_free_mb: number;
  pressure: string;
  used_pct: number;
}

/** Full daemon status response */
export interface DaemonStatus {
  daemon_start: string;
  boot_complete: boolean;
  adb_fixed: boolean;
  procs: ProcessCount;
  wake_lock: boolean;
  memory: SystemMemory | null;
  quota: QuotaStatus | null;
  sessions: SessionState[];
}

/** Memory command response */
export interface MemoryResponse {
  system: SystemMemory;
  sessions: Array<{
    name: string;
    rss_mb: number | null;
    activity: string | null;
  }>;
}

/** Log entry */
export interface LogEntry {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  session?: string;
  [key: string]: unknown;
}

/** CFC bridge health response */
export interface BridgeHealth {
  status: string;
  version?: string;
  clients?: number;
  uptime?: number;
  cdp?: {
    state: string;
    edgePid?: number;
    port?: number;
    targets?: number;
  };
  lastTool?: string;
  lastToolTime?: string;
  error?: string;
}

/** ADB device info */
export interface AdbDevice {
  serial: string;
  state: string;
}

/** ADB status response from daemon */
export interface AdbStatus {
  devices: AdbDevice[];
  connecting?: boolean;
}

/** Recent Claude project from history.jsonl */
export interface RecentProject {
  name: string;
  path: string;
  last_active: string;
  session_id: string;
  status: "running" | "registered" | "config" | "untracked";
}

/** Script entry from daemon's script discovery */
export interface ScriptEntry {
  name: string;        // "build-on-termux.sh", "dev", "test"
  path: string;        // absolute path (empty for package.json)
  source: "root" | "scripts" | "package.json" | "saved";
  command?: string;    // for package.json: the command value
}

// -- Customization / Settings types ------------------------------------------

/** MCP server entry from ~/.claude.json or settings.json */
export interface McpServerInfo {
  name: string;
  scope: "user" | "project";
  source: "claude-json" | "settings-json" | "mcp-json";
  command: string;
  args: string[];
  env?: Record<string, string>;
  disabled: boolean;
}

/** Installed plugin from installed_plugins.json + enabledPlugins + blocklist */
export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  author: string;
  scope: "user" | "project";
  enabled: boolean;
  blocked: boolean;
  blockReason?: string;
  version: string;
  installedAt: string;
  installPath: string;
  type: "native" | "external";
  installs?: number;
}

/** Skill file (.md) from ~/.claude/skills/ or project .claude/skills/ */
export interface SkillInfo {
  name: string;
  path: string;
  scope: "user" | "project";
  source?: string;
}

/** Plan file (.md) from ~/.claude/plans/ or project .claude/plans/ */
export interface PlanInfo {
  name: string;
  path: string;
  scope: "user" | "project";
}

/** CLAUDE.md / MEMORY.md file reference */
export interface ClaudeMdInfo {
  label: string;
  path: string;
  scope: "user" | "project" | "memory";
}

/** Hook definition from settings.json */
export interface HookInfo {
  event: string;
  matcher: string;
  type: string;
  command: string;
  timeout?: number;
  /** "user" = ~/.claude/settings.json, "project" = <projectPath>/.claude/settings.json */
  scope?: "user" | "project";
}

/** Plugin available in a marketplace */
export interface MarketplacePlugin {
  id: string;
  name: string;
  description: string;
  author: string;
  marketplace: string;
  type: "native" | "external";
  installed: boolean;
  enabled: boolean;
  installs: number;
}

/** Marketplace sources and available plugins */
export interface MarketplaceInfo {
  sources: Array<{ name: string; repo: string; lastUpdated: string }>;
  available: MarketplacePlugin[];
}

// -- Token tracking -----------------------------------------------------------

/** Token usage for a single Claude session JSONL file */
export interface SessionTokenUsage {
  session_id: string;
  jsonl_path: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  turns: number;
  cost_usd: number;
  file_size_bytes: number;
  last_modified: string;
}

/** Aggregated token usage for a project (all JSONL files) */
export interface ProjectTokenUsage {
  name: string;
  path: string;
  sessions: SessionTokenUsage[];
  total: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    turns: number;
    cost_usd: number;
  };
}

// -- Conversation viewer ------------------------------------------------------

/** A single structured block within an assistant message */
export interface ConversationBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result";
  text?: string;
  tool_name?: string;
  tool_input?: string;
  tool_result?: string;
}

/** A single conversation entry */
export interface ConversationEntry {
  uuid: string;
  type: "user" | "assistant" | "tool_result";
  timestamp: string;
  content: string;
  blocks?: ConversationBlock[];
  usage?: { input: number; output: number; cache_read: number; cache_create: number };
  model?: string;
}

/** Paginated conversation response */
export interface ConversationPage {
  entries: ConversationEntry[];
  oldest_uuid: string | null;
  has_more: boolean;
  session_id: string;
  session_list: Array<{ id: string; last_modified: string; title?: string }>;
}

// -- Session timeline ---------------------------------------------------------

/** A single event in the session timeline */
export interface TimelineEvent {
  timestamp: string;
  source: "trace" | "conversation" | "state";
  event: string;
  detail?: string;
}

// -- Prompt library -----------------------------------------------------------

/** A single prompt from history.jsonl */
export interface PromptEntry {
  id: string;
  display: string;
  timestamp: number;
  project: string;
  sessionId?: string;
  starred: boolean;
}

/** Paginated prompt search result */
export interface PromptSearchResult {
  prompts: PromptEntry[];
  total: number;
  offset: number;
  limit: number;
}

// -- Daily cost timeline ------------------------------------------------------

/** Aggregated cost data for a single day */
export interface DailyCost {
  date: string;
  input_cost: number;
  output_cost: number;
  cache_cost: number;
  total_cost: number;
  turns: number;
  sessions: Array<{ session_id: string; name: string; cost: number }>;
}

// -- Token quota status -------------------------------------------------------

/** Token quota status for subscription-based rate limiting */
export interface QuotaStatus {
  /** Auto-detected plan label, e.g. "Max 20x", "Pro" */
  plan: string | null;
  /** Raw rate limit tier from credentials, e.g. "default_claude_max_20x" */
  rate_limit_tier: string | null;
  weekly_tokens_used: number;
  weekly_tokens_limit: number;
  weekly_pct: number;
  weekly_level: "ok" | "warning" | "critical" | "exceeded" | "unconfigured";
  window_tokens_used: number;
  window_hours: number;
  tokens_per_hour: number;
  daily_avg_tokens: number;
  velocity_trend: "rising" | "falling" | "stable";
  projected_weekly_total: number;
  top_sessions: Array<{ name: string; tokens: number; pct: number }>;
}

/** Daily token usage breakdown */
export interface DailyTokens {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  turns: number;
}

// -- Conversation delta (live streaming) --------------------------------------

/** New conversation entries pushed via SSE */
export interface ConversationDelta {
  session: string;
  entries: ConversationEntry[];
  session_id: string;
}

// -- Notification history -----------------------------------------------------

/** Notification types emitted by the daemon */
export type NotificationType =
  | "session_start" | "session_stop" | "session_error"
  | "battery_low" | "memory_pressure"
  | "daemon_start" | "daemon_stop";

/** A single notification record */
export interface NotificationRecord {
  id: string;
  timestamp: string;
  type: NotificationType;
  title: string;
  content: string;
  session?: string;
}

// -- Git info -----------------------------------------------------------------

/** Git repository status for a session */
export interface GitInfo {
  branch: string;
  dirty_files: string[];
  recent_commits: Array<{ hash: string; message: string }>;
}

/** File entry in a directory listing */
export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

/** File content response */
export interface FileContentResponse {
  content: string;
  language: string;
  size: number;
  truncated: boolean;
}

// -- Telemetry sink -----------------------------------------------------------

/** Known telemetry SDK identifiers */
export type TelemetrySdk =
  | "aria" | "onecollector" | "adjust" | "appcenter" | "ecs"
  | "analytics" | "vortex" | "google" | "rewards" | "webxt" | "unknown";

/** A single captured telemetry request */
export interface TelemetryRecord {
  ts: string;
  method: string;
  path: string;
  host: string;
  content_type: string;
  user_agent: string;
  body_bytes: number;
  body_preview: string;
  sdk: TelemetrySdk;
}

/** Aggregated telemetry stats */
export interface TelemetryStats {
  total: number;
  per_hour: number;
  by_sdk: Record<string, number>;
  started_at: string;
}

/** Full telemetry API response */
export interface TelemetryResponse {
  records: TelemetryRecord[];
  stats: TelemetryStats;
}

// -- Customization / Settings types ------------------------------------------

/** Slash command from .claude/commands/*.md */
export interface CommandInfo {
  name: string;
  path: string;
  scope: "user" | "project";
}

/** Claude subagent definition from .claude/agents/*.md */
export interface AgentMdInfo {
  name: string;
  path: string;
  scope: "user" | "project";
}

/** User-authored context note from .claude/memories/*.md */
export interface MemoryFileInfo {
  name: string;
  path: string;
  scope: "user" | "project";
}

/** Cross-tool AGENTS.md file (Claude Code + Codex + OpenCode compat) */
export interface AgentsMdFile {
  label: string;
  path: string;
  scope: "user" | "project";
  /** Tool names that read this file, e.g. ["Claude Code", "Codex", "OpenCode"] */
  consumers: string[];
}

/** Full customization response from /api/customization */
export interface CustomizationResponse {
  mcpServers: McpServerInfo[];
  plugins: PluginInfo[];
  skills: SkillInfo[];
  plans: PlanInfo[];
  claudeMds: ClaudeMdInfo[];
  hooks: HookInfo[];
  marketplace: MarketplaceInfo;
  projectPath?: string;
  /** Slash commands from .claude/commands/*.md */
  commands?: CommandInfo[];
  /** Subagent definitions from .claude/agents/*.md */
  agentsMd?: AgentMdInfo[];
  /** User-authored context notes from .claude/memories/*.md */
  memories?: MemoryFileInfo[];
  /** Cross-tool AGENTS.md files */
  agentsMdFiles?: AgentsMdFile[];
}

/** Per-project entry in the all-projects aggregated customization response */
export interface ProjectCustomizationEntry {
  path: string;
  name: string;
  hooks: HookInfo[];
  skills: SkillInfo[];
  plans: PlanInfo[];
  /** Slash commands from .claude/commands/*.md */
  commands?: CommandInfo[];
  /** Subagent definitions from .claude/agents/*.md */
  agentsMd?: AgentMdInfo[];
  /** User-authored context notes from .claude/memories/*.md */
  memories?: MemoryFileInfo[];
  /** Single CLAUDE.md for this project (if present) */
  claudeMd?: ClaudeMdInfo;
  /** Single AGENTS.md for this project (if present) */
  agentsMdFile?: AgentsMdFile;
}

/** Response from /api/customization/all-projects */
export interface AllProjectsCustomizationResponse {
  user: {
    hooks: HookInfo[];
    skills: SkillInfo[];
    plans: PlanInfo[];
    /** Slash commands from ~/.claude/commands/ */
    commands?: CommandInfo[];
    /** Subagent definitions from ~/.claude/agents/ */
    agentsMd?: AgentMdInfo[];
    /** User-authored context notes from ~/.claude/memories/ */
    memories?: MemoryFileInfo[];
    /** CLAUDE.md files at user scope */
    claudeMds?: ClaudeMdInfo[];
    /** Cross-tool AGENTS.md files at user scope */
    agentsMdFiles?: AgentsMdFile[];
  };
  projects: ProjectCustomizationEntry[];
}

// -- SDK streaming types ------------------------------------------------------

/** SDK bridge status from /api/sdk/status */
export interface SdkBridgeStatus {
  attached: boolean;
  sessionName: string | null;
  busy: boolean;
}

/** SDK permission request sent via WS */
export interface SdkPermissionRequest {
  type: "permission_request";
  id: string;
  tool: string;
  input: unknown;
  timeout_ms: number;
}

/** SDK assistant message sent via WS */
export interface SdkAssistantMessage {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: {
    role: string;
    content: Array<{
      type: string;
      text?: string;
      thinking?: string;
      name?: string;
      input?: unknown;
      id?: string;
    }>;
    stop_reason?: string;
  };
  parent_tool_use_id: string | null;
}

/** SDK result message sent via WS */
export interface SdkResultMessage {
  type: "result";
  subtype: string;
  session_id: string;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: { input_tokens: number; output_tokens: number };
  is_error: boolean;
  result_text?: string;
}

/** SDK system message sent via WS */
export interface SdkSystemMessage {
  type: "system";
  subtype: string;
  session_id: string;
  tools?: string[];
  model?: string;
  version?: string;
}

/** Union of SDK WS messages */
export type SdkWsMessage =
  | SdkPermissionRequest
  | SdkAssistantMessage
  | SdkResultMessage
  | SdkSystemMessage
  | { type: "attached"; sessionName: string; sessionId: string }
  | { type: "detached"; sessionName: string }
  | { type: "interrupted" }
  | { type: "prompt_start"; prompt: string }
  | { type: "error"; message: string };

// -- Memory types -------------------------------------------------------------

/** Memory category */
export type MemoryCategory = "convention" | "decision" | "discovery" | "warning" | "user_preference";

/** Memory record from /api/memories */
export interface MemoryRecord {
  id: number;
  project_path: string;
  category: MemoryCategory;
  content: string;
  relevance_score: number;
  source_session_id: string | null;
  created_at: number;
  accessed_at: number;
  expires_at: number | null;
}

// -- Agent system -------------------------------------------------------------

/** Agent definition from /api/agents */
export interface AgentInfo {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  disallowed_tools?: string[];
  model?: string;
  max_turns?: number;
  background?: boolean;
  memory?: "user" | "project" | "local";
  effort?: "low" | "medium" | "high" | "max";
  permission_mode?: string;
  max_budget_usd?: number;
  enabled: boolean;
  source: "builtin" | "toml" | "project" | "user";
}

/** Agent run record from /api/agents/runs (list view — text is preview only). */
export interface AgentRunRecord {
  id: number;
  agent_name: string;
  session_name: string;
  session_id: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  started_at: number;
  finished_at: number | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  turns: number;
  error: string | null;
  trigger: string;
  /** User-supplied prompt that triggered the run (may be null for older runs). */
  prompt: string | null;
  /** First ~280 chars of response_text (null when run produced no text). */
  response_preview: string | null;
  /** True when full response is longer than the preview — fetch detail to expand. */
  has_more_response: 0 | 1;
  /** True when the run captured extended thinking output. */
  has_thinking: 0 | 1;
}

/** Full agent run record from /api/agents/runs/<id> — includes complete bodies. */
export interface AgentRunDetail extends Omit<AgentRunRecord, "response_preview" | "has_more_response" | "has_thinking"> {
  response_text: string | null;
  thinking_text: string | null;
}

/** Per-agent cost summary from /api/agents/costs */
export interface AgentCostSummary {
  agent_name: string;
  total_cost: number;
  run_count: number;
  avg_cost: number;
}

// -- Cognitive system ---------------------------------------------------------

/** Goal record from /api/cognitive/goals */
export interface GoalRecord {
  id: number;
  parent_id: number | null;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  agent_name: string | null;
  expected_outcome: string | null;
  actual_outcome: string | null;
  success_score: number | null;
  children_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/** Decision record from /api/cognitive/decisions */
export interface DecisionRecord {
  id: number;
  agent_name: string;
  session_name: string | null;
  goal_id: number | null;
  action: string;
  rationale: string;
  alternatives: string | null;
  expected_outcome: string | null;
  actual_outcome: string | null;
  score: number | null;
  created_at: number;
  evaluated_at: number | null;
}

/** User profile entry from /api/profile */
export interface ProfileEntry {
  id: number;
  category: "chat_export" | "note" | "trait" | "style" | "preference";
  content: string;
  weight: number;
  source: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

/** Profile preview from /api/profile/preview */
export interface ProfilePreview {
  preview: string;
  counts: { traits: number; notes: number; styles: number; chat_exports: number };
}

// -- SDK cost tracking --------------------------------------------------------

/** Aggregate cost data from /api/costs */
export interface SdkCostAggregate {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_duration_ms: number;
  total_turns: number;
  query_count: number;
}

/** Daily cost from SDK cost tracking */
export interface SdkDailyCost {
  date: string;
  cost_usd: number;
  queries: number;
}

/** Per-session cost from SDK cost tracking */
export interface SdkSessionCost {
  session_name: string;
  total_cost: number;
  queries: number;
}

// -- Agent chat ---------------------------------------------------------------

/** Agent conversation message from /api/agent-chat/:name */
export interface AgentChatMessage {
  id: number;
  agent_name: string;
  role: "user" | "assistant" | "system";
  content: string;
  session_id: string | null;
  thinking: string | null;
  cost_usd: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: number;
}

/** Inter-agent message from /api/agent-messages */
export interface AgentMessage {
  id: number;
  from_agent: string;
  to_agent: string;
  message_type: string;
  content: string;
  metadata: string | null;
  read_at: number | null;
  created_at: number;
}

/** Agent conversation pair summary */
export interface ConversationPair {
  agent1: string;
  agent2: string;
  message_count: number;
  last_message_at: number;
}

/** Agent personality trait */
export interface PersonalityTrait {
  trait_name: string;
  trait_value: number;
  evidence: string | null;
}

/** Agent learning record */
export interface AgentLearning {
  id: number;
  agent_name: string;
  category: string;
  content: string;
  confidence: number;
  reinforcement_count: number;
  created_at: number;
  last_reinforced_at: number;
}

/** Agent specialization record */
export interface AgentSpecialization {
  id: number;
  agent_name: string;
  domain: string;
  confidence: number;
  evidence: string | null;
  reinforcement_count: number;
  created_at: number;
  updated_at: number;
}

// -- Switchboard --------------------------------------------------------------

/** Switchboard — master control for enabling/disabling subsystems */
export interface Switchboard {
  /** Master kill-switch — if false, all autonomous subsystems disabled */
  all: boolean;
  /** SDK bridge (streaming, attach/detach) */
  sdkBridge: boolean;
  /** Cognitive timer (periodic OODA checks) */
  cognitive: boolean;
  /** OODA auto-trigger (automatic master controller runs) */
  oodaAutoTrigger: boolean;
  /** Memory injection into SDK queries */
  memoryInjection: boolean;
  /** Mind meld profile injection into OODA prompts */
  mindMeld: boolean;
  /** Per-agent enable overrides — false force-disables */
  agents: Record<string, boolean>;
}
