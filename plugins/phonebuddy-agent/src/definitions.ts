import type { PluginListenerHandle } from '@capacitor/core';

/**
 * PhoneBuddy agent engine (public Apache-2.0 SDK) as a Capacitor plugin.
 *
 * Why this plugin exists
 * ---------------------
 * The pinned `capacitor-native-agent` generation (0.5.2) has no OS wake
 * scheduler and no surfaced-message store, so `NativeKit.agent` could only
 * answer `{ supported: false }` for those two modern features. The PhoneBuddy
 * engine is public, builds for every Android ABI (armeabi-v7a included) and its
 * C ABI (`native/include/phone_buddy.h`) exposes exactly the hooks a host needs:
 *
 *   * `ph_engine_set_host_callbacks` → the engine fires *host events*
 *     (`scheduler_registered`, `scheduler_cancelled`, `notification_send`,
 *     `notification_schedule`, `monitor`) that the app is expected to turn into
 *     real OS work (JobScheduler / BGTaskScheduler / notifications);
 *   * `pb_engine_get_session` / `pb_engine_list_sessions` → the persisted
 *     conversation store that background runs write into.
 *
 * On top of those, this plugin owns the two pieces the pinned engine lacks:
 *   * **background wakes** — a periodic JobScheduler job (Android) /
 *     BGProcessingTask (iOS) that rebuilds the engine headlessly, runs the due
 *     `scheduler.json` tasks and posts their results as notifications;
 *   * **surfaced messages** — a durable record of everything the agent produced
 *     while the user was not looking, so the UI can catch up on next launch.
 */

/** Result of the never-rejecting availability probe. */
export interface PhoneBuddyAvailability {
  /** Primary ABI of this device, e.g. `armeabi-v7a`. */
  abi: string;
  is64Bit: boolean;
  /** True when `libphone_buddy_ffi.so` loaded on this ABI. */
  available: boolean;
  /** Populated when `available` is false. */
  reason?: string;
  /** Engine generation marker, e.g. `phonebuddy-0.2.0`. */
  engineGeneration: string;
  /** `pb_version()` of the loaded library. */
  version?: string;
}

/**
 * Engine configuration. Either pass a complete `configJson` (the raw
 * `phone_buddy::config::EngineConfig` shape) or the individual fields and let the
 * plugin assemble it.
 *
 * Required by the engine: `model`, `root_dir` (defaulted to the app sandbox) and
 * — unless the host supplies the LLM over the host-callback transport —
 * `api_key` + `base_url`.
 */
export interface PhoneBuddyInitializeOptions {
  /** Raw EngineConfig JSON; wins over the individual fields below. */
  configJson?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** File sandbox root; defaults to `<app files>/phonebuddy`. */
  rootDir?: string;
  locale?: string;
  agentName?: string;
  systemPromptExtra?: string;
  maxTurns?: number;
  temperature?: number;
  maxOutputTokens?: number;
  /** Extra EngineConfig keys merged verbatim (forward compatibility). */
  extra?: Record<string, unknown>;
}

export interface PhoneBuddyInitializeResult {
  initialized: boolean;
  rootDir: string;
  model: string;
  engineGeneration: string;
  /** Keys the plugin had to fill in (e.g. `root_dir`). */
  defaultsApplied: string[];
}

export interface PhoneBuddyChatOptions {
  /** Session id; defaults to `main`. */
  sessionId?: string;
  /** Plain user text (used for `pb_engine_chat`). */
  text?: string;
  /** Structured turn JSON (used for `pb_engine_chat_v2` when given). */
  turnJson?: string;
}

export interface PhoneBuddyChatResult {
  sessionId: string;
  /** `final_text` from the engine result object. */
  finalText: string;
  turnsUsed?: number;
  usageJson?: string;
  /** Raw result JSON, for hosts that want everything. */
  resultJson: string;
}

export interface PhoneBuddyWakeOptions {
  /** Targeting interval in minutes (Android floors this at 15). */
  intervalMinutes?: number;
}

/**
 * Never rejects: an OS that refuses the job resolves with
 * `jobScheduled: false` and a reason.
 */
export interface PhoneBuddyWakeResult {
  jobScheduled: boolean;
  /** Interval the OS actually granted (may differ from the request). */
  intervalMinutes: number;
  engineGeneration: string;
  /** Earliest approximate next run, epoch millis (Android). */
  nextRunApproxMs?: number;
  reason?: string;
}

export interface PhoneBuddyWakeStatus {
  jobScheduled: boolean;
  intervalMinutes: number;
  lastWakeAt?: string;
  lastWakeSource?: string;
  lastWakeSummary?: string;
  /** Tasks in `scheduler.json` still marked `scheduled`. */
  pendingTasks: number;
  engineGeneration: string;
}

/** One record produced while the user was not looking. */
export interface PhoneBuddySurfacedMessage {
  id: string;
  /** ISO-8601 timestamp. */
  at: string;
  /** `background` | `notification` | `monitor` | `chat`. */
  source: string;
  sessionId?: string;
  taskId?: string;
  title?: string;
  body?: string;
  text?: string;
  read: boolean;
}

export interface PhoneBuddyLoadSurfacedOptions {
  /** Newest-first page size (default 50). */
  limit?: number;
  /** Mark the returned messages as read (default false). */
  markRead?: boolean;
}

export interface PhoneBuddySurfacedResult {
  /** JSON array of {@link PhoneBuddySurfacedMessage}. */
  messagesJson: string;
  count: number;
  unread: number;
  engineGeneration: string;
}

export interface PhoneBuddyToggleResult {
  ok: boolean;
  engineGeneration: string;
  reason?: string;
}

export interface PhoneBuddyAgentPlugin {
  /** Never rejects. */
  checkAvailability(): Promise<PhoneBuddyAvailability>;

  initialize(options: PhoneBuddyInitializeOptions): Promise<PhoneBuddyInitializeResult>;
  shutdown(): Promise<void>;

  sendMessage(options: PhoneBuddyChatOptions): Promise<PhoneBuddyChatResult>;
  abort(options: { sessionId?: string }): Promise<void>;

  listSessions(): Promise<{ sessionsJson: string }>;
  getSession(options: { sessionId: string }): Promise<{ sessionJson: string }>;
  deleteSession(options: { sessionId: string }): Promise<{ deleted: boolean }>;

  /** Host tools (OpenAI tools JSON array) the engine may call back into. */
  setHostTools(options: { toolsJson: string }): Promise<PhoneBuddyToggleResult>;
  hostToolResult(options: { callId: string; ok: boolean; output: string }): Promise<PhoneBuddyToggleResult>;

  // ── modern features that the pinned native-agent generation lacks ─────────
  scheduleBackgroundWakes(options?: PhoneBuddyWakeOptions): Promise<PhoneBuddyWakeResult>;
  cancelBackgroundWakes(): Promise<PhoneBuddyWakeResult>;
  getWakeStatus(): Promise<PhoneBuddyWakeStatus>;
  /** Runs due scheduled tasks immediately (foreground catch-up). */
  handleWake(options?: { source?: string }): Promise<{ ran: number; summary: string; engineGeneration: string }>;

  loadSurfacedMessages(options?: PhoneBuddyLoadSurfacedOptions): Promise<PhoneBuddySurfacedResult>;
  clearSurfacedMessages(): Promise<{ cleared: number; engineGeneration: string }>;

  /**
   * Streams engine events for the running turn (`TextDelta`,
   * `ToolCallStart`, `ToolCallResult`, `Completed`, …). Events fired by a
   * background wake are NOT delivered this way — the process may not exist —
   * they are persisted and read back with {@link loadSurfacedMessages}.
   */
  addListener(
    eventName: 'phoneBuddyEvent',
    listenerFunc: (event: PhoneBuddyEvent) => void,
  ): Promise<PluginListenerHandle>;
}

/** Events streamed while a turn runs (`pb_engine_chat*` callback). */
export interface PhoneBuddyEvent {
  eventType: string;
  payloadJson: string;
  sessionId?: string;
}
