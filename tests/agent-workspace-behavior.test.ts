import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// agent-workspace.js is a browser module that touches the DOM at load time, so
// it cannot be imported under Node. These tests take the named top-level helpers
// out of the shipped source and evaluate exactly that text. The helpers are pure,
// so the behaviour under test is the behaviour the browser runs.
const source = readFileSync(path.join(process.cwd(), 'www/agent-workspace.js'), 'utf8');

function extract(names: string[]): string {
  const lines = source.split('\n');
  return names.map((name) => {
    const start = lines.findIndex((line) => new RegExp(`^(?:async )?function ${name}\\(|^const ${name} =`).test(line));
    if (start < 0) throw new Error(`helper not found: ${name}`);
    const first = lines[start];
    let end = start;
    if (/^(?:async )?function /.test(first)) {
      if (!/\}\s*$/.test(first)) end = lines.findIndex((line, i) => i > start && line === '}');
    } else if (!/;\s*$/.test(first)) {
      end = lines.findIndex((line, i) => i > start && /^\S.*;\s*$/.test(line));
    }
    if (end < 0) throw new Error(`unterminated helper: ${name}`);
    return lines.slice(start, end + 1).join('\n');
  }).join('\n');
}

const helpers = new Function(
  `${extract([
    'bytes', 'safeText', 'redactLogText', 'LOG_SECRET_KEY', 'LOG_BODY_KEY', 'safeLogValue',
    'eventTone', 'eventSummary', 'sanitizeStoredEvent',
    'AGENT_ERROR_ADVICE', 'AGENT_ERROR_PATTERNS', 'classifyAgentError',
  ])}\nreturn { safeLogValue, sanitizeStoredEvent, classifyAgentError, AGENT_ERROR_ADVICE, AGENT_ERROR_PATTERNS };`,
)() as {
  safeLogValue: (value: unknown, key?: string, depth?: number) => any;
  sanitizeStoredEvent: (entry: unknown, index?: number) => any;
  classifyAgentError: (error: unknown, reportedCategory?: string) => { code: string; message: string; detail: string };
  AGENT_ERROR_ADVICE: Record<string, string>;
  AGENT_ERROR_PATTERNS: Array<[string, RegExp]>;
};

const { safeLogValue, sanitizeStoredEvent, classifyAgentError, AGENT_ERROR_ADVICE, AGENT_ERROR_PATTERNS } = helpers;

describe('agent audit log values', () => {
  it('keeps the real provider error phrase while masking the secret inside it', () => {
    const data = safeLogValue({
      error: 'API error (401): invalid key sk-or-v1-abcdefghijklmnop123 rejected',
      sessionKey: 'chat-42',
    });
    expect(data.error).toContain('API error (401)');
    expect(data.error).toContain('rejected');
    expect(data.error).not.toContain('abcdefghijklmnop123');
    expect(data.sessionKey).toBe('chat-42');
  });

  it('withholds credentials by key name but not counters such as maxTokens', () => {
    const data = safeLogValue({ apiKey: 'plain-value', token: 'x-y-z', maxTokens: 4096, inputTokens: 12 });
    expect(data.apiKey).toBe('[redacted]');
    expect(data.token).toBe('[redacted]');
    expect(data.maxTokens).toBe(4096);
    expect(data.inputTokens).toBe(12);
  });

  it('withholds prompts, file bodies, tool arguments/results and thinking by size only', () => {
    const data = safeLogValue({
      prompt: 'আমার ব্যক্তিগত পরিকল্পনা', content: 'file body',
      args: { path: 'secret.txt', query: 'private question' },
      result: 'full tool output', output: 'provider response',
      thinking: 'private reasoning', messagesJson: '[full transcript]',
      promptCharacters: 24, sessionKey: 'chat-private',
    });
    expect(data.prompt).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.content).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.args).toBe('[redacted]');
    expect(data.result).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.output).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.thinking).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.messagesJson).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.promptCharacters).toBe(24);
    expect(data.sessionKey).toBe('chat-private');
  });

  it('masks exposed GitHub PAT formats even when they appear inside error text', () => {
    const data = safeLogValue({ error: 'request failed with github_pat_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(data.error).toContain('request failed');
    expect(data.error).not.toContain('github_pat_');
    expect(data.error).toContain('[redacted]');
  });

  it('masks bearer tokens inside free text', () => {
    const data = safeLogValue({ reason: 'upstream said Bearer abc.def.ghi was invalid' });
    expect(data.reason).not.toContain('abc.def.ghi');
    expect(data.reason).toContain('invalid');
  });

  it('re-sanitizes persisted event details and rebuilds summaries from safe fields', () => {
    const saved = sanitizeStoredEvent({
      id: 'sk-or-v1-abcdefghijklmnop123456',
      at: 1_700_000_000_000,
      type: 'agent.error',
      tone: 'unexpected-class',
      summary: 'PRIVATE prompt: do not display this saved text',
      data: {
        prompt: 'আমার ব্যক্তিগত পরিকল্পনা',
        error: 'API error (401): invalid Bearer abc.def.ghi',
        sessionKey: 'chat-42',
      },
    }, 2);

    expect(saved.id).toBe('stored-1700000000000-2');
    expect(saved.summary).not.toContain('PRIVATE prompt');
    expect(saved.summary).not.toContain('abc.def.ghi');
    expect(saved.summary).toContain('API error (401)');
    expect(saved.data.prompt).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(saved.data.error).not.toContain('abc.def.ghi');
    expect(saved.data.sessionKey).toBe('chat-42');
    expect(saved.tone).toBe('err');
  });

  it('keeps untrusted details from polluting the object prototype', () => {
    const data = safeLogValue(JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}'));
    expect(Object.getPrototypeOf(data)).toBeNull();
    expect(data.__proto__.polluted).toBe(true);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('agent error classification', () => {
  it('trusts the typed category from the native event over the message text', () => {
    expect(classifyAgentError('Rate limited, retry after 5000ms', 'auth').code).toBe('auth');
  });

  it('falls back to specific template patterns when no category is reported', () => {
    expect(classifyAgentError('Rate limited, retry after 5000ms').code).toBe('rate_limit');
    expect(classifyAgentError('API error (401): bad key').code).toBe('auth');
    expect(classifyAgentError('Parse error: invalid JSON in provider SSE event').code).toBe('stream_protocol');
    expect(classifyAgentError('Network connection error: connection reset').code).toBe('network');
  });

  it('does not invent a category from incidental words', () => {
    // Regression: the old broad regex reported these as context/stream faults.
    expect(classifyAgentError('the user asked about parsing a CSV file').code).toBe('provider_error');
    expect(classifyAgentError('quota of ideas is high today').code).toBe('provider_error');
    expect(classifyAgentError('please summarise the context of this poem').code).toBe('provider_error');
  });

  it('ignores an unknown reported category and keeps the original phrase as detail', () => {
    const diagnosis = classifyAgentError('API error (401): bad token=abc123', 'made_up');
    expect(diagnosis.code).toBe('auth');
    expect(diagnosis.detail).toContain('API error (401)');
    expect(diagnosis.detail).not.toContain('abc123');
  });

  it('gives every category Bangla advice and no pattern points at an unknown category', () => {
    for (const message of Object.values(AGENT_ERROR_ADVICE)) expect(message.length).toBeGreaterThan(10);
    for (const [code] of AGENT_ERROR_PATTERNS) expect(AGENT_ERROR_ADVICE).toHaveProperty(code);
  });
});

describe('agent ask-user card wiring', () => {
  it('listens for the bridge ask event and answers on the paired response event', () => {
    expect(source).toContain("window.addEventListener('nativekit:agent-ask',");
    expect(source).toContain('nativekit:agent-ask-response');
    expect(source).toContain('Agent জিজ্ঞেস করছে');
    // Option buttons are capped to match the bridge tool schema (2–6 options).
    expect(source).toContain('.slice(0, 6)');
  });
});
