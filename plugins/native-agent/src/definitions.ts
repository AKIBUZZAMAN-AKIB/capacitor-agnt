/**
 * Capacitor Native Agent — plugin definitions.
 *
 * Mirrors the UniFFI-exported API from Rust (NativeAgentHandle).
 * The WebView engine.ts delegates ALL logic here — no agent logic in JS.
 */

// ── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Result of the availability probe. Never rejects: on a device whose ABI has no
 * packaged `.so` it resolves `{ available: false }` with a human-readable reason
 * instead of throwing (and without crashing the app).
 */
export interface AgentAvailabilityResult {
  /** Primary ABI reported by the platform, e.g. "armeabi-v7a". */
  abi: string
  /** Whether the device advertises any 64-bit ABI. */
  is64Bit: boolean
  available: boolean
  /** Empty when available; otherwise why the native library could not load. */
  reason: string
  /** Which upstream plugin generation this build is pinned to, e.g. "0.5.2-public". */
  engineGeneration?: string
}

// ── Config & params ─────────────────────────────────────────────────────────

export interface InitConfig {
  /** Path to the SQLite database */
  dbPath: string
  /** Path to the workspace root */
  workspacePath: string
  /** Path to auth-profiles.json */
  authProfilesPath: string
}

/**
 * Tool approval policy understood by the engine.
 *
 * These exact strings matter: the engine compares against `always_allow`, so a
 * looser spelling such as `'allow'` silently meant "keep asking". The union
 * makes a typo a compile error instead of a runtime surprise.
 */
export type ToolPermissionPolicy = 'always_allow' | 'always_ask' | 'always_ask_biometric'

export interface SendMessageParams {
  prompt: string
  sessionKey: string
  model?: string
  provider?: string
  systemPrompt: string
  maxTurns?: number
  /** JSON-encoded list of allowed tool names. Empty = all tools. */
  allowedToolsJson?: string
  /**
   * JSON-encoded prior conversation messages for multi-turn skill sessions.
   *
   * NOTE: there is deliberately no `extraToolsJson` here. It used to be
   * declared but the native `SendMessageParams` (Rust and Kotlin alike) has no
   * such field, so anything passed was silently dropped. Register extra tools
   * with `setMcpTools` / `startMcp` instead.
   */
  priorMessagesJson?: string
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export interface AuthTokenResult {
  apiKey: string | null
  isOAuth: boolean
}

export interface AuthStatusResult {
  hasKey: boolean
  masked: string
  provider: string
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface SessionInfo {
  sessionKey: string
  agentId: string
  updatedAt: number
  model?: string
  totalTokens?: number
}

export interface SessionHistoryResult {
  sessionKey: string
  /** JSON-encoded messages array */
  messagesJson: string
}

// ── Scheduler / heartbeat / cron ─────────────────────────────────────────────

export interface SchedulerConfig {
  enabled: boolean
  schedulingMode: string
  runOnCharging: boolean
  globalActiveHoursJson?: string
}

export interface HeartbeatConfig {
  enabled: boolean
  everyMs: number
  prompt?: string
  skillId?: string
  activeHoursJson?: string
  nextRunAt?: number
  lastHash?: string
  lastSentAt?: number
}

export interface CronJobInput {
  name: string
  enabled?: boolean
  sessionTarget?: string
  wakeMode?: string
  scheduleJson: string
  skillId: string
  prompt: string
  deliveryMode?: string
  deliveryWebhookUrl?: string
  deliveryNotificationTitle?: string
  activeHoursJson?: string
}

export interface CronJobRecord {
  id: string
  name: string
  enabled: boolean
  sessionTarget: string
  wakeMode: string
  scheduleJson: string
  skillId: string
  prompt: string
  deliveryMode: string
  deliveryWebhookUrl?: string
  deliveryNotificationTitle?: string
  activeHoursJson?: string
  lastRunAt?: number
  nextRunAt?: number
  lastRunStatus?: string
  lastError?: string
  lastDurationMs?: number
  consecutiveErrors: number
  createdAt: number
  updatedAt: number
}

export interface CronRunRecord {
  id: number
  jobId: string
  startedAt: number
  endedAt?: number
  status: string
  durationMs?: number
  error?: string
  responseText?: string
  wakeSource?: string
}

export interface CronSkillInput {
  name: string
  allowedToolsJson?: string
  systemPrompt?: string
  model?: string
  maxTurns?: number
  timeoutMs?: number
}

export interface ScheduleBackgroundWakesOptions {
  /**
   * Interval to ask the OS for, in minutes. Android's WorkManager floors periodic
   * work at 15 minutes; iOS treats the value as a floor (`earliestBeginDate`),
   * not a promise. The answer states what was actually granted.
   */
  intervalMinutes?: number
}

/** `loadSurfacedMessages()` page options. */
export interface LoadSurfacedMessagesOptions {
  /** Newest-first page size (default 50, max 500). */
  limit?: number
  /** Mark the returned page as read (default false). */
  markRead?: boolean
}

/**
 * One record produced while the user was not looking: a cron run a wake
 * finished, or a notification the engine posted during it.
 */
export interface SurfacedMessage {
  id: string
  /** ISO-8601 timestamp. */
  at: string
  /** `background` | `notification`. */
  source: string
  read: boolean
  title?: string
  body?: string
  text?: string
  /** Cron job / run the record came from (engine `cron_runs` row). */
  jobId?: string
  taskId?: string
  runId?: number
  status?: string
  delivered?: boolean
}

export interface SurfacedMessagesResult {
  /** JSON array of {@link SurfacedMessage}. */
  messagesJson: string
  count: number
  unread: number
  limit?: number
  markRead?: boolean
  lastWakeAt?: string | null
  lastWakeSource?: string | null
  lastWakeSummary?: string | null
  engineGeneration?: string
  platform?: string
}

/** Result of a foreground catch-up wake (`handleWake`). */
export interface HandleWakeResult {
  /** Cron jobs that ran to completion. */
  ran: number
  /** Cron jobs that ended in an error. */
  failed: number
  /** Surfaced records this wake appended. */
  surfaced: number
  summary: string
}

/** What `scheduleBackgroundWakes()` / `cancelBackgroundWakes()` report. */
export interface BackgroundWakeResult {
  jobScheduled: boolean
  /** Interval the OS actually granted (may differ from the request). */
  intervalMinutes: number
  /** Interval the caller asked for, before platform floors. */
  requestedIntervalMinutes?: number
  requiresCharging?: boolean
  minIntervalMinutes?: number
  /** Epoch millis; only present when the scheduler knows it (Android ENQUEUED). */
  nextRunApproxMs?: number | null
  jobCancelled?: boolean
  engineGeneration?: string
  platform?: string
  /** `WorkManager PeriodicWorkRequest` (Android) or `BGTaskScheduler BGProcessingTask` (iOS). */
  mechanism?: string
  workName?: string
  workState?: string | null
  runAttemptCount?: number
  taskIdentifier?: string
  /** iOS: the system, not the app, picks the moment. */
  opportunistic?: boolean
  schedulerEnabled?: boolean
  heartbeatIntervalMinutes?: number
  reason?: string
}

/** Live scheduler state plus the last wake's outcome. */
export interface BackgroundWakeStatus extends BackgroundWakeResult {
  lastWakeAt?: string | null
  lastWakeSource?: string | null
  lastWakeSummary?: string | null
  lastWakeRan?: number
  lastWakeOk?: boolean
  unreadSurfaced?: number
  engineInitialized?: boolean
  /** Cron jobs still waiting to run. */
  pendingTasks?: number | null
  enabledCronJobs?: number | null
  dueCronJobs?: number | null
  /** iOS: the identifier is whitelisted in Info.plist. */
  permitted?: boolean
}

export interface CronSkillRecord {
  id: string
  name: string
  allowedToolsJson?: string
  systemPrompt?: string
  model?: string
  maxTurns?: number
  timeoutMs?: number
  createdAt: number
  updatedAt: number
}

// ── Models ───────────────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string
  name: string
  description: string
  isDefault: boolean
}

// ── Token usage ──────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

// ── Events ───────────────────────────────────────────────────────────────────

/**
 * Every event type the Rust engine emits, verified against the emit sites in
 * the crate. `heartbeat.skipped` and `scheduler.status` were listed here but
 * are never emitted; the cron/wake/heartbeat events below were emitted but
 * missing from the union.
 */
export type NativeAgentEventType =
  // ── Streaming / turn lifecycle ──
  | 'text_delta'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'mcp_tool_call'
  | 'user_message'
  | 'approval_request'
  | 'retry'
  | 'web_search_start'
  | 'web_search_complete'
  | 'max_turns_reached'
  | 'agent.background_timeout'
  | 'agent.completed'
  | 'agent.error'
  // ── Wake / scheduler ──
  | 'wake.no_jobs'
  | 'wake.jobs_found'
  | 'wake.skipped'
  /**
   * The wake ran out of its total time budget and stopped between jobs.
   * `deferred` jobs were left untouched and stay due, so the next wake picks
   * them up. Emitted instead of letting the OS kill the background task.
   */
  | 'wake.budget_exhausted'
  // ── Cron ──
  | 'cron.job.started'
  | 'cron.job.completed'
  | 'cron.job.error'
  | 'cron.job.skipped'
  | 'cron.notification'
  | 'cron.deduped'
  | 'cron.delivery_skipped'
  // ── Heartbeat ──
  | 'heartbeat.started'
  | 'heartbeat.completed'
  | 'heartbeat.error'

export interface NativeAgentEvent {
  eventType: string
  payloadJson: string
}

// ── Plugin interface ─────────────────────────────────────────────────────────

export interface NativeAgentPlugin {
  // ── Diagnostics ──

  checkAvailability(): Promise<AgentAvailabilityResult>

  // ── Lifecycle ──

  initWorkspace(config: InitConfig): Promise<void>
  initialize(config: InitConfig): Promise<void>

  // ── Agent ──

  sendMessage(params: SendMessageParams): Promise<{ runId: string }>
  followUp(options: { prompt: string }): Promise<void>
  abort(): Promise<void>
  steer(options: { text: string }): Promise<void>

  // ── Approval gate ──

  respondToApproval(options: { toolCallId: string; approved: boolean; reason?: string }): Promise<void>
  /**
   * Answer a pending `mcp_tool_call`.
   *
   * `resultJson` SHOULD be an MCP `CallToolResult`, which you can forward from
   * your server verbatim:
   *
   * ```json
   * { "content": [{ "type": "text", "text": "16C" }], "isError": false }
   * ```
   *
   * The engine flattens `content` into the text the model reads (image, audio
   * and resource blocks are described rather than inlined as base64) and keeps
   * `structuredContent` — including on the error path, where servers put error
   * codes and retry hints.
   *
   * The `isError` INSIDE the result is honoured and OR-ed with the `isError`
   * argument, so forwarding a failed `CallToolResult` verbatim correctly tells
   * the model the call failed. Per the MCP spec that is the whole point of the
   * field: the model has to see the failure to be able to self-correct.
   *
   * Anything that is not shaped like a `CallToolResult` — plain text, or your
   * own JSON — is passed through to the model unchanged.
   */
  respondToMcpTool(options: { toolCallId: string; resultJson: string; isError?: boolean }): Promise<void>

  // ── Auth ──

  getAuthToken(options: { provider: string }): Promise<AuthTokenResult>
  setAuthKey(options: { key: string; provider: string; authType: string }): Promise<void>
  deleteAuth(options: { provider: string }): Promise<void>
  refreshToken(options: { provider: string }): Promise<AuthTokenResult>
  getAuthStatus(options: { provider: string }): Promise<AuthStatusResult>
  exchangeOAuthCode(options: { tokenUrl: string; bodyJson: string; contentType?: string }): Promise<{ success: boolean; status?: number; data?: any; text?: string; error?: string }>

  // ── Sessions ──

  listSessions(options: { agentId: string }): Promise<{ sessionsJson: string }>
  loadSession(options: { sessionKey: string; agentId: string }): Promise<SessionHistoryResult>
  resumeSession(options: { sessionKey: string; agentId: string; messagesJson?: string; provider?: string; model?: string }): Promise<void>
  clearSession(): Promise<void>

  // ── Cron / heartbeat ──

  addCronJob(options: { inputJson: string }): Promise<{ recordJson: string }>
  updateCronJob(options: { id: string; patchJson: string }): Promise<void>
  removeCronJob(options: { id: string }): Promise<void>
  listCronJobs(): Promise<{ jobsJson: string }>
  runCronJob(options: { jobId: string }): Promise<void>
  listCronRuns(options: { jobId?: string; limit?: number }): Promise<{ runsJson: string }>
  /** Foreground catch-up: runs every due cron job and surfaces the results. */
  handleWake(options: { source: string }): Promise<HandleWakeResult>

  getSchedulerConfig(): Promise<{ schedulerJson: string; heartbeatJson: string }>
  setSchedulerConfig(options: { configJson: string }): Promise<void>
  setHeartbeatConfig(options: { configJson: string }): Promise<void>

  // ── Background wakes (OS scheduling owned by the plugin) ──────────────────
  //
  // The engine runs wakes but cannot ask Android/iOS for background runtime; the
  // plugin does that (WorkManager periodic work / BGProcessingTask) and reports
  // what the OS actually granted. See docs/API-REFERENCE.bn.md.
  scheduleBackgroundWakes(options?: ScheduleBackgroundWakesOptions): Promise<BackgroundWakeResult>
  cancelBackgroundWakes(): Promise<BackgroundWakeResult>
  getWakeStatus(): Promise<BackgroundWakeStatus>

  /** What the agent produced while the user was not looking. */
  loadSurfacedMessages(options?: LoadSurfacedMessagesOptions): Promise<SurfacedMessagesResult>
  clearSurfacedMessages(): Promise<{ cleared: number; unread?: number; engineGeneration?: string; platform?: string }>

  respondToCronApproval(options: { requestId: string; approved: boolean }): Promise<void>

  // ── Skills ──

  addSkill(options: { inputJson: string }): Promise<{ recordJson: string }>
  updateSkill(options: { id: string; patchJson: string }): Promise<void>
  removeSkill(options: { id: string }): Promise<void>
  listSkills(): Promise<{ skillsJson: string }>

  startSkill(options: { skillId: string; configJson: string; provider?: string }): Promise<{ sessionKey: string }>
  endSkill(options: { skillId: string }): Promise<void>

  // ── Tool Permissions ──

  seedToolPermissions(options: { defaultsJson: string }): Promise<{ seeded: number }>
  setToolPermission(options: {
    toolName: string
    permission: ToolPermissionPolicy
    enabled: boolean
  }): Promise<void>
  listToolPermissions(): Promise<{ permissionsJson: string }>
  resetToolPermissions(): Promise<void>

  // ── MCP ──
  //
  // IMPORTANT — what this plugin does and does not do.
  //
  // It is NOT an MCP client. There is no JSON-RPC layer, no stdio or
  // Streamable-HTTP transport, and nothing that speaks `tools/list` or
  // `tools/call` to an MCP server. The engine only keeps a CATALOGUE of tool
  // definitions and dispatches calls back to your WebView code.
  //
  // You own the MCP client. The wiring is:
  //
  //   1. Your JS connects to the MCP server and calls `tools/list`.
  //   2. Pass those tools to `startMcp` / `setMcpTools` so the model can see
  //      them. The JSON is an array of
  //      `{ name, description?, inputSchema?, approvalPolicy? }`.
  //   3. When the model calls one, the plugin emits a `mcp_tool_call` event
  //      with `{ toolCallId, toolName, args }` and BLOCKS the turn.
  //   4. Your code forwards it to the server as `tools/call` and returns the
  //      reply with `respondToMcpTool`.
  //
  // The turn is blocked for at most 30 seconds; after that the model is told
  // the tool timed out. A tool name that is in neither the built-in set nor
  // this catalogue fails immediately rather than waiting out that timeout.

  startMcp(options: { toolsJson: string }): Promise<{ toolCount: number }>
  restartMcp(options: { toolsJson: string }): Promise<{ toolCount: number }>

  // ── Models ──

  getModels(options: { provider: string }): Promise<{ modelsJson: string }>

  // ── Tools ──

  invokeTool(options: { toolName: string; argsJson: string }): Promise<{ resultJson: string }>

  // ── Events ──

  addListener(
    eventName: 'nativeAgentEvent',
    handler: (event: NativeAgentEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>
}
