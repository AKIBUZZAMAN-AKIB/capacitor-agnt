import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('OVHcloud GPT-OSS protocol compatibility', () => {
  const responsesDriver = read('plugins/native-agent/rust/native-agent-ffi/src/protocol_drivers.rs');
  const routing = read('plugins/native-agent/rust/native-agent-ffi/src/agent_loop.rs');
  const catalog = read('plugins/native-agent/rust/native-agent-ffi/src/provider_catalog.rs');

  it('retains the narrow Responses compatibility guard for non-GPT-OSS routes', () => {
    expect(responsesDriver).toContain('parallel_tool_calls_supported: bool');
    expect(responsesDriver).toContain('pub fn without_parallel_tool_calls');
    expect(responsesDriver).toContain('if self.parallel_tool_calls_supported { body["parallel_tool_calls"] = json!(false); }');
    expect(responsesDriver).toContain('responses_gateway_can_omit_unsupported_parallel_tool_calls');
    expect(routing).toContain('if route.provider == "ovhcloud"');
    expect(routing).toContain('driver.without_parallel_tool_calls()');
  });

  it('routes OVH GPT-OSS agent turns through documented Chat Completions tool messages', () => {
    // OVH rejects the generic Responses driver's rich `input_text` item array
    // as ResponseInput. The Chat driver instead emits messages/tools and
    // role:"tool" follow-ups, matching OVH's function-calling documentation.
    expect(responsesDriver).toContain('"content":[{"type":if message.role == Role::Assistant {"output_text"} else {"input_text"}');
    expect(catalog).toContain('fn is_ovh_gpt_oss_model');
    expect(catalog).toContain('if provider == "ovhcloud" && is_ovh_gpt_oss_model(model)');
    expect(catalog).toContain('return Some(ProviderProtocol::OpenAiChatCompletions);');
    expect(catalog).toContain('ovh_gpt_oss_ignores_legacy_responses_override_and_uses_chat_tools');
    expect(catalog).not.toContain('"ovhcloud" if is_ovh_responses_model(model) => Some(ProviderProtocol::OpenAiResponses)');
    expect(routing).toContain('ProviderProtocol::OpenAiChatCompletions');
  });
});
