/*
 * NativeKit Trusted-Types shim for the vendored PageAgent bundle.
 *
 * Runs at document start, BEFORE the page-agent bundle: sites that enforce
 * `Content-Security-Policy: require-trusted-types-for 'script'` (YouTube,
 * Google sign-in, ...) reject every plain-string assignment to innerHTML with
 * a TypeError, which kills the agent panel before it can render. The vendored
 * demo bundle builds its cards via innerHTML, so without this shim the agent
 * simply never appears on those pages.
 *
 * Rules of engagement:
 *  - PROBE FIRST: a detached <div> is assigned a plain string. If the page does
 *    NOT enforce Trusted Types the shim leaves the page 100% untouched.
 *  - Only when enforcement actually throws do we create a pass-through policy
 *    and wrap the DOM HTML sinks (innerHTML/outerHTML/insertAdjacentHTML on
 *    Element and ShadowRoot) to hand the native setter TrustedHTML.
 *    Note: on enforcement pages WITHOUT a `trusted-types` name allowlist (the
 *    YouTube/Google case) any page script could create such a policy itself,
 *    so this adds no bypass the page did not already permit.
 *  - If the page locks policy names (`trusted-types 'x' ...`) the policy
 *    creation fails and the page is left untouched (panel may not render —
 *    accepted limitation; those sites are rare).
 *  - __nativekitEval is ALWAYS installed (even without enforcement): the
 *    bundle's executeJavascript tool calls it so agent-generated scripts keep
 *    working on enforcing pages (eval(TrustedScript) is TT-legal).
 */
(function () {
  'use strict';
  if (window.__nativekitTTShim) return;
  window.__nativekitTTShim = true;

  var policy = null;
  try {
    var api = window.trustedTypes;
    if (api && typeof api.createPolicy === 'function') {
      var names = ['nativekit-agent', 'nk-agent-a17f3', 'nk-agent-b29d6'];
      for (var i = 0; i < names.length && policy === null; i += 1) {
        try {
          policy = api.createPolicy(names[i], {
            createHTML: function (value) { return value; },
            createScript: function (value) { return value; },
            createScriptURL: function (value) { return value; },
          });
        } catch (error) { policy = null; }
      }
    }
  } catch (error) { policy = null; }

  // TT-safe eval for the vendored bundle (executeJavascript tool).
  try {
    window.__nativekitEval = function (source) {
      if (policy && typeof source === 'string') {
        try { return (0, eval)(policy.createScript(source)); } catch (error) { /* fall through */ }
      }
      return (0, eval)(source);
    };
  } catch (error) { /* best effort */ }

  // Is Trusted Types actually enforced on this page? If not, stop here —
  // nothing below may touch a page that does not need it.
  var enforced = false;
  try {
    var probe = document.createElement('div');
    try { probe.innerHTML = '<b></b>'; } catch (error) { enforced = true; }
  } catch (error) { return; }
  if (!enforced || !policy) return;

  function trustedHtml(value) {
    if (typeof value !== 'string') return value;
    try { return policy.createHTML(value); } catch (error) { return value; }
  }

  function wrapHtmlSetter(owner, name) {
    try {
      var descriptor = Object.getOwnPropertyDescriptor(owner.prototype, name);
      if (!descriptor || typeof descriptor.set !== 'function') return;
      Object.defineProperty(owner.prototype, name, {
        get: descriptor.get,
        set: function (value) { descriptor.set.call(this, trustedHtml(value)); },
        configurable: true,
        enumerable: descriptor.enumerable,
      });
    } catch (error) { /* keep the native setter */ }
  }

  if (window.Element) {
    wrapHtmlSetter(window.Element, 'innerHTML');
    wrapHtmlSetter(window.Element, 'outerHTML');
  }
  if (window.ShadowRoot) {
    wrapHtmlSetter(window.ShadowRoot, 'innerHTML');
    wrapHtmlSetter(window.ShadowRoot, 'outerHTML');
  }
  try {
    var adjacent = Object.getOwnPropertyDescriptor(window.Element.prototype, 'insertAdjacentHTML');
    if (adjacent && typeof adjacent.value === 'function') {
      Object.defineProperty(window.Element.prototype, 'insertAdjacentHTML', {
        value: function (position, markup) { adjacent.value.call(this, position, trustedHtml(markup)); },
        writable: true,
        configurable: true,
      });
    }
  } catch (error) { /* optional */ }
})();
