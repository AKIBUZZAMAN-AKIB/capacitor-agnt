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
    'AGENT_ERROR_ADVICE', 'AGENT_ERROR_PATTERNS', 'classifyAgentError',
  ])}\nreturn { safeLogValue, classifyAgentError, AGENT_ERROR_ADVICE, AGENT_ERROR_PATTERNS };`,
)() as {
  safeLogValue: (value: unknown, key?: string, depth?: number) => any;
  classifyAgentError: (error: unknown, reportedCategory?: string) => { code: string; message: string; detail: string };
  AGENT_ERROR_ADVICE: Record<string, string>;
  AGENT_ERROR_PATTERNS: Array<[string, RegExp]>;
};

const { safeLogValue, classifyAgentError, AGENT_ERROR_ADVICE, AGENT_ERROR_PATTERNS } = helpers;

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

  it('withholds conversation and file bodies by size only', () => {
    const data = safeLogValue({ prompt: 'আমার ব্যক্তিগত পরিকল্পনা', content: 'file body' });
    expect(data.prompt).toMatch(/^\[redacted · \d+ bytes\]$/);
    expect(data.content).toMatch(/^\[redacted · \d+ bytes\]$/);
  });

  it('masks bearer tokens inside free text', () => {
    const data = safeLogValue({ reason: 'upstream said Bearer abc.def.ghi was invalid' });
    expect(data.reason).not.toContain('abc.def.ghi');
    expect(data.reason).toContain('invalid');
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
