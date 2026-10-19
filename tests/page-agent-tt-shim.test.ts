/**
 * PageAgent Trusted-Types shim (plugins/isolated-browser/android/src/main/
 * assets/pageagent/tt-shim.js) — runs at document start BEFORE the vendored
 * page-agent bundle so the agent panel can render on Trusted-Types-enforcing
 * sites (youtube.com, accounts.google.com enforce
 * `require-trusted-types-for 'script'`; arena.ai does not — which is exactly
 * why the panel used to appear on arena.ai and vanish on YouTube/Google).
 *
 * These tests run the real asset inside a stubbed DOM and pin the contract:
 *  1. no trustedTypes API  -> page untouched, but __nativekitEval still works;
 *  2. TT present, not enforced -> page 100% untouched (no prototype wrapping);
 *  3. TT enforced           -> plain-string innerHTML keeps working (wrapped
 *                              into TrustedHTML), eval routes via the policy;
 *  4. TT enforced + locked policy names -> page untouched (no fake bypass).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SHIM = fs.readFileSync(
  path.join(__dirname, '../plugins/isolated-browser/android/src/main/assets/pageagent/tt-shim.js'),
  'utf8',
);

interface FakeElement { _html: string; innerHTML: any; }

interface Env {
  window: Record<string, any>;
  scriptSpy: string[];
}

function makeEnv(options: { enforceTT?: boolean; hasTT?: boolean; allowPolicyNames?: string[] | null } = {}): Env {
  const { enforceTT = false, hasTT = true, allowPolicyNames = null } = options;
  const scriptSpy: string[] = [];

  const Element = function Element() {} as any;
  Object.defineProperty(Element.prototype, 'innerHTML', {
    configurable: true,
    enumerable: true,
    get(this: FakeElement) { return this._html; },
    set(this: FakeElement, value: any) {
      if (enforceTT && typeof value === 'string') throw new TypeError("This document requires 'TrustedHTML' assignment.");
      this._html = value;
    },
  });

  const trustedTypes = hasTT
    ? {
        createPolicy(name: string) {
          if (allowPolicyNames && !allowPolicyNames.includes(name)) throw new TypeError('policy name not allowed');
          return {
            createHTML: (value: string) => ({ __trustedHTML: value }),
            createScript: (value: string) => { scriptSpy.push(value); return value; },
          };
        },
      }
    : undefined;

  const window: Record<string, any> = { document: { createElement: () => Object.create(Element.prototype) }, Element };
  if (trustedTypes) window.trustedTypes = trustedTypes;
  window.window = window; // in a browser, `window` is the global itself
  vm.runInContext(SHIM, vm.createContext(window), { filename: 'tt-shim.js' });
  return { window, scriptSpy };
}

function elementIn(env: Env): FakeElement {
  return Object.create(env.window.Element.prototype) as FakeElement;
}

describe('pageagent tt-shim asset', () => {
  it('installs __nativekitEval even without the trustedTypes API and leaves assignments alone', () => {
    const env = makeEnv({ hasTT: false });
    expect(typeof env.window.__nativekitEval).toBe('function');
    expect(env.window.__nativekitEval('1+2')).toBe(3);
    const element = elementIn(env);
    element.innerHTML = '<b>plain</b>';
    expect(element._html).toBe('<b>plain</b>');
  });

  it('leaves pages without Trusted-Types enforcement completely untouched', () => {
    const env = makeEnv({ enforceTT: false });
    const before = Object.getOwnPropertyDescriptor(env.window.Element.prototype, 'innerHTML');
    const element = elementIn(env);
    element.innerHTML = '<b>plain</b>';
    expect(element._html).toBe('<b>plain</b>');
    const after = Object.getOwnPropertyDescriptor(env.window.Element.prototype, 'innerHTML');
    expect(after?.set).toBe(before?.set); // setter NOT replaced
  });

  it('wraps innerHTML into TrustedHTML on enforcing pages (the YouTube/Google case)', () => {
    const env = makeEnv({ enforceTT: true });
    const element = elementIn(env);
    expect(() => { element.innerHTML = '<b>card</b>'; }).not.toThrow();
    expect((element._html as any).__trustedHTML).toBe('<b>card</b>');
    // Objects (already-trusted values) pass straight through.
    const trusted = { __trustedHTML: '<i>ok</i>' };
    element.innerHTML = trusted as any;
    expect(element._html).toBe(trusted as any);
  });

  it('routes __nativekitEval through the policy on enforcing pages', () => {
    const env = makeEnv({ enforceTT: true });
    expect(env.window.__nativekitEval('6*7')).toBe(42);
    expect(env.scriptSpy).toContain('6*7');
  });

  it('never fakes a bypass when the page locks Trusted-Types policy names', () => {
    const env = makeEnv({ enforceTT: true, allowPolicyNames: ['pagepolicy'] });
    const element = elementIn(env);
    expect(() => { element.innerHTML = '<b>x</b>'; }).toThrow(TypeError); // still enforced, page untouched
    expect(env.window.__nativekitEval('2+3')).toBe(5); // falls back to plain eval
  });
});
