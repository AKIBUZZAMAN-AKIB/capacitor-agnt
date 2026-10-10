import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('OVHcloud Responses compatibility', () => {
  const driver = read('plugins/native-agent/rust/native-agent-ffi/src/protocol_drivers.rs');
  const routing = read('plugins/native-agent/rust/native-agent-ffi/src/agent_loop.rs');

  it('omits only the unsupported parallel_tool_calls field for OVH Responses routes', () => {
    expect(driver).toContain('parallel_tool_calls_supported: bool');
    expect(driver).toContain('pub fn without_parallel_tool_calls');
    expect(driver).toContain('if self.parallel_tool_calls_supported { body["parallel_tool_calls"] = json!(false); }');
    expect(driver).toContain('responses_gateway_can_omit_unsupported_parallel_tool_calls');
    expect(routing).toContain('if route.provider == "ovhcloud"');
    expect(routing).toContain('driver.without_parallel_tool_calls()');
  });
});
