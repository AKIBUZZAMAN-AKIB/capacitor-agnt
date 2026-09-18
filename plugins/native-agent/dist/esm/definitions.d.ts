/**
 * Capacitor Native Agent — plugin definitions.
 *
 * Mirrors the UniFFI-exported API from Rust (NativeAgentHandle).
 * The WebView engine.ts delegates ALL logic here — no agent logic in JS.
 */
export interface InitConfig {
    /** Path to the SQLite database */
    dbPath: string;
    /** Path to the workspace root */
    workspacePath: string;
    /** Path to auth-profiles.json */
    authProfilesPath: string;
    /**
     * Configured default LLM provider for this agent. When a per-call
     * `provider` is unset on `sendMessage` / cron / skill paths, the
     * resolver falls back to this value. Omitting it falls through to
     * the hardcoded "anthropic" safety net — properly-set-up agents
     * should always specify this.
     */
    defaultProvider?: string;
    /**
     * Configured default model. Only applies when the resolver also
     * uses `defaultProvider` (i.e. caller didn't override provider).
     * If provider is overridden, the per-provider default model is
     * used instead, since model strings are tied to providers.
     */
    defaultModel?: string;
}
export interface SendMessageParams {
    prompt: string;
    sessionKey: string;
    model?: string;
    provider?: string;
    systemPrompt: string;
    maxTurns?: number;
    /**
     * Optional skill-mode whitelist of allowed tool names (JSON-encoded array).
     * Undefined or empty = no skill restriction. The FFI also applies its own
     * per-turn permission filter from the AgentStore on top of this list.
     */
    skillAllowedToolsJson?: string;
    /** JSON-encoded prior conversation messages for multi-turn skill sessions */
    priorMessagesJson?: string;
}
export interface AuthTokenResult {
    apiKey: string | null;
    isOAuth: boolean;
}
export interface AuthStatusResult {
    hasKey: boolean;
    masked: string;
    provider: string;
}
export interface SessionInfo {
    sessionKey: string;
    agentId: string;
    updatedAt: number;
    model?: string;
    totalTokens?: number;
}
export interface SessionHistoryResult {
    sessionKey: string;
    /** JSON-encoded messages array */
    messagesJson: string;
}
export interface SchedulerConfig {
    enabled: boolean;
    schedulingMode: string;
    runOnCharging: boolean;
    globalActiveHoursJson?: string;
}
export interface HeartbeatConfig {
    enabled: boolean;
    everyMs: number;
    prompt?: string;
    skillId?: string;
    activeHoursJson?: string;
    nextRunAt?: number;
    lastHash?: string;
    lastSentAt?: number;
}
export interface CronJobInput {
    name: string;
    enabled?: boolean;
    sessionTarget?: string;
    wakeMode?: string;
    scheduleJson: string;
    skillId: string;
    prompt: string;
    deliveryMode?: string;
    deliveryWebhookUrl?: string;
    deliveryNotificationTitle?: string;
    activeHoursJson?: string;
}
export interface CronJobRecord {
    id: string;
    name: string;
    enabled: boolean;
    sessionTarget: string;
    wakeMode: string;
    scheduleJson: string;
    skillId: string;
    prompt: string;
    deliveryMode: string;
    deliveryWebhookUrl?: string;
    deliveryNotificationTitle?: string;
    activeHoursJson?: string;
    lastRunAt?: number;
    nextRunAt?: number;
    lastRunStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
    consecutiveErrors: number;
    createdAt: number;
    updatedAt: number;
}
export interface CronRunRecord {
    id: number;
    jobId: string;
    startedAt: number;
    endedAt?: number;
    status: string;
    durationMs?: number;
    error?: string;
    responseText?: string;
    wakeSource?: string;
}
export interface CronSkillInput {
    name: string;
    allowedToolsJson?: string;
    systemPrompt?: string;
    model?: string;
    /**
     * Optional per-skill provider override. When unset, the cron path
     * falls back to the agent's `InitConfig.defaultProvider`.
     */
    provider?: string;
    maxTurns?: number;
    timeoutMs?: number;
}
export interface CronSkillRecord {
    id: string;
    name: string;
    allowedToolsJson?: string;
    systemPrompt?: string;
    model?: string;
    /** Per-skill provider override; null when the skill defers to the agent default. */
    provider?: string;
    maxTurns?: number;
    timeoutMs?: number;
    createdAt: number;
    updatedAt: number;
}
export interface ModelInfo {
    id: string;
    name: string;
    description: string;
    isDefault: boolean;
}
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}
export type NativeAgentEventType = 'text_delta' | 'thinking' | 'tool_use' | 'tool_result' | 'mcp_tool_call' | 'user_message' | 'retry' | 'agent.completed' | 'agent.error' | 'approval_request' | 'wake.no_jobs' | 'wake.jobs_found' | 'agent.background_timeout' | 'max_turns_reached' | 'heartbeat.started' | 'heartbeat.completed' | 'heartbeat.skipped' | 'cron.job.started' | 'cron.job.completed' | 'cron.job.error' | 'cron.notification' | 'scheduler.status';
export interface NativeAgentEvent {
    eventType: string;
    payloadJson: string;
}
/**
 * Result of `checkAvailability()`. On Android, `available: false` means the
 * native library is missing for the device ABI (e.g. a 32-bit device when
 * only arm64-v8a was shipped) — the app should show a friendly message
 * instead of letting `initialize()` reject. On iOS the FFI library is
 * statically linked, so `available` is always true.
 */
export interface AvailabilityInfo {
    /** The device ABI (Android) or machine (iOS, e.g. "arm64"). */
    abi: string;
    /** Whether the native library can be loaded/used on this device. */
    available: boolean;
    /** True on 64-bit capable devices (Android). Always true on iOS. */
    is64Bit?: boolean;
    /** Human-readable failure reason when `available` is false. */
    reason?: string;
}
/** Result of `scheduleBackgroundWakes()`. */
export interface BackgroundWakeScheduleResult {
    jobScheduled: boolean;
    /**
     * The interval the OS actually honored. Android floors it at 15 min
     * (API 24+) / 30 min (API 23); iOS BGProcessing is opportunistic and
     * this value only sets the earliest begin date.
     */
    intervalMinutes: number;
    reason?: string;
}
export interface NativeAgentPlugin {
    initWorkspace(config: InitConfig): Promise<void>;
    initialize(config: InitConfig): Promise<void>;
    /**
     * Probe whether the native agent library is usable on this device without
     * touching the agent state. Never rejects — an unsupported architecture
     * resolves with `available: false`.
     */
    checkAvailability(): Promise<AvailabilityInfo>;
    /**
     * Schedule periodic background wakes (Android: framework JobScheduler,
     * min 15 min; iOS: BGProcessingTask — requires the host app to add
     * `BGTaskSchedulerPermittedIdentifiers` containing
     * `io.t6x.nativeagent.wake` plus Background Modes → "Background fetch").
     * Resolves (not rejects) with `jobScheduled: false` + `reason` when it
     * cannot schedule.
     */
    scheduleBackgroundWakes(options?: {
        intervalMinutes?: number;
    }): Promise<BackgroundWakeScheduleResult>;
    cancelBackgroundWakes(): Promise<{
        cancelled: boolean;
    }>;
    sendMessage(params: SendMessageParams): Promise<{
        runId: string;
    }>;
    followUp(options: {
        prompt: string;
    }): Promise<void>;
    abort(): Promise<void>;
    steer(options: {
        text: string;
    }): Promise<void>;
    respondToApproval(options: {
        toolCallId: string;
        approved: boolean;
        reason?: string;
    }): Promise<void>;
    respondToMcpTool(options: {
        toolCallId: string;
        resultJson: string;
        isError?: boolean;
    }): Promise<void>;
    /**
     * Replace the FFI's MCP tool manifest. Tools registered here become
     * visible to the LLM (subject to `webviewOnly` filtering in background
     * mode) and, when invoked, surface as `mcp_tool_call` events that the
     * host must answer with `respondToMcpTool`. Idempotent — every call
     * replaces the prior manifest.
     *
     * `toolsJson` is a JSON-encoded array of
     *   { name, description?, inputSchema?, webviewOnly?, approvalPolicy? }.
     * Returns the count of registered tools.
     */
    setMcpTools(options: {
        toolsJson: string;
    }): Promise<{
        count: number;
    }>;
    getAuthToken(options: {
        provider: string;
    }): Promise<AuthTokenResult>;
    setAuthKey(options: {
        key: string;
        provider: string;
        authType: string;
        refresh?: string;
        expiresAt?: number;
    }): Promise<void>;
    deleteAuth(options: {
        provider: string;
    }): Promise<void>;
    refreshToken(options: {
        provider: string;
    }): Promise<AuthTokenResult>;
    getAuthStatus(options: {
        provider: string;
    }): Promise<AuthStatusResult>;
    exchangeOAuthCode(options: {
        tokenUrl: string;
        bodyJson: string;
        contentType?: string;
    }): Promise<{
        success: boolean;
        status?: number;
        data?: any;
        text?: string;
        error?: string;
    }>;
    listSessions(options: {
        agentId?: string;
    }): Promise<{
        sessionsJson: string;
    }>;
    loadSession(options: {
        sessionKey: string;
        agentId?: string;
    }): Promise<SessionHistoryResult>;
    resumeSession(options: {
        sessionKey: string;
        agentId?: string;
        messagesJson?: string;
        provider?: string;
        model?: string;
    }): Promise<{
        wasInterrupted: boolean;
    }>;
    clearSession(): Promise<void>;
    addCronJob(options: {
        inputJson: string;
    }): Promise<{
        recordJson: string;
    }>;
    updateCronJob(options: {
        id: string;
        patchJson: string;
    }): Promise<void>;
    removeCronJob(options: {
        id: string;
    }): Promise<void>;
    listCronJobs(): Promise<{
        jobsJson: string;
    }>;
    runCronJob(options: {
        jobId: string;
    }): Promise<void>;
    listCronRuns(options: {
        jobId?: string;
        limit?: number;
    }): Promise<{
        runsJson: string;
    }>;
    loadSurfacedMessages(options: {
        limit?: number;
    }): Promise<{
        messagesJson: string;
    }>;
    handleWake(options?: {
        source?: string;
    }): Promise<void>;
    getSchedulerConfig(): Promise<{
        schedulerJson: string;
        heartbeatJson: string;
    }>;
    setSchedulerConfig(options: {
        configJson: string;
    }): Promise<void>;
    setHeartbeatConfig(options: {
        configJson: string;
    }): Promise<void>;
    respondToCronApproval(options: {
        requestId: string;
        approved: boolean;
    }): Promise<void>;
    addSkill(options: {
        inputJson: string;
    }): Promise<{
        recordJson: string;
    }>;
    updateSkill(options: {
        id: string;
        patchJson: string;
    }): Promise<void>;
    removeSkill(options: {
        skillId: string;
    }): Promise<void>;
    listSkills(): Promise<{
        skillsJson: string;
    }>;
    startSkill(options: {
        skillId: string;
        configJson?: string;
        provider?: string;
    }): Promise<{
        sessionKey: string;
    }>;
    endSkill(options: {
        skillId: string;
    }): Promise<void>;
    seedToolPermissions(options: {
        defaultsJson: string;
    }): Promise<{
        seeded: number;
    }>;
    setToolPermission(options: {
        toolName: string;
        permission: string;
        enabled?: boolean;
    }): Promise<void>;
    listToolPermissions(): Promise<{
        permissionsJson: string;
    }>;
    resetToolPermissions(): Promise<void>;
    startMcp(options: {
        toolsJson: string;
    }): Promise<{
        toolCount: number;
    }>;
    restartMcp(options: {
        toolsJson: string;
    }): Promise<{
        toolCount: number;
    }>;
    getModels(options: {
        provider: string;
    }): Promise<{
        modelsJson: string;
    }>;
    invokeTool(options: {
        toolName: string;
        argsJson: string;
    }): Promise<{
        resultJson: string;
    }>;
    addListener(eventName: 'nativeAgentEvent', handler: (event: NativeAgentEvent) => void): Promise<{
        remove: () => Promise<void>;
    }>;
}
//# sourceMappingURL=definitions.d.ts.map