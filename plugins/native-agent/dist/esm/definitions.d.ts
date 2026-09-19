/**
 * Capacitor Native Agent — plugin definitions.
 *
 * Mirrors the UniFFI-exported API from Rust (NativeAgentHandle).
 * The WebView engine.ts delegates ALL logic here — no agent logic in JS.
 */
/**
 * Result of the availability probe. Never rejects: on a device whose ABI has no
 * packaged `.so` it resolves `{ available: false }` with a human-readable reason
 * instead of throwing (and without crashing the app).
 */
export interface AgentAvailabilityResult {
    /** Primary ABI reported by the platform, e.g. "armeabi-v7a". */
    abi: string;
    /** Whether the device advertises any 64-bit ABI. */
    is64Bit: boolean;
    available: boolean;
    /** Empty when available; otherwise why the native library could not load. */
    reason: string;
    /** Which upstream plugin generation this build is pinned to, e.g. "0.5.2-public". */
    engineGeneration?: string;
}
export interface InitConfig {
    /** Path to the SQLite database */
    dbPath: string;
    /** Path to the workspace root */
    workspacePath: string;
    /** Path to auth-profiles.json */
    authProfilesPath: string;
}
export interface SendMessageParams {
    prompt: string;
    sessionKey: string;
    model?: string;
    provider?: string;
    systemPrompt: string;
    maxTurns?: number;
    /** JSON-encoded list of allowed tool names. Empty = all tools. */
    allowedToolsJson?: string;
    /** JSON-encoded extra tool definitions (account tools, MCP tools) */
    extraToolsJson?: string;
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
    maxTurns?: number;
    timeoutMs?: number;
}
export interface CronSkillRecord {
    id: string;
    name: string;
    allowedToolsJson?: string;
    systemPrompt?: string;
    model?: string;
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
export interface NativeAgentPlugin {
    checkAvailability(): Promise<AgentAvailabilityResult>;
    initWorkspace(config: InitConfig): Promise<void>;
    initialize(config: InitConfig): Promise<void>;
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
    getAuthToken(options: {
        provider: string;
    }): Promise<AuthTokenResult>;
    setAuthKey(options: {
        key: string;
        provider: string;
        authType: string;
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
        agentId: string;
    }): Promise<{
        sessionsJson: string;
    }>;
    loadSession(options: {
        sessionKey: string;
        agentId: string;
    }): Promise<SessionHistoryResult>;
    resumeSession(options: {
        sessionKey: string;
        agentId: string;
        messagesJson?: string;
        provider?: string;
        model?: string;
    }): Promise<void>;
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
    handleWake(options: {
        source: string;
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
        id: string;
    }): Promise<void>;
    listSkills(): Promise<{
        skillsJson: string;
    }>;
    startSkill(options: {
        skillId: string;
        configJson: string;
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
        enabled: boolean;
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