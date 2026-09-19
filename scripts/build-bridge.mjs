#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { rootDir, validateConfig } from './config-lib.mjs';

const { config } = await validateConfig();
const outDir = path.join(rootDir, '.nativekit', 'bridge');
await fs.mkdir(outDir, { recursive: true });

await build({
  entryPoints: [path.join(rootDir, 'bridge', 'nativekit.ts')],
  outfile: path.join(outDir, 'nativekit.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  define: {
    __NATIVEKIT_CONFIG__: JSON.stringify({
      app: config.app,
      features: config.features,
      network: config.network,
      security: {
        trustedLocalContentOnly: config.security.trustedLocalContentOnly,
      },
      appBrowser: config.appBrowser,
      backgroundRunner: {
        label: config.backgroundRunner.label,
        event: config.backgroundRunner.event,
        defaultSyncUrl: config.backgroundRunner.defaultSyncUrl,
      },
      // Defaults for the agent's OS wake + surfaced-message inbox; the native
      // side still owns the real values (it reports what the OS granted).
      agent: {
        wakeIntervalMinutes: config.agent.wakeIntervalMinutes,
        minWakeIntervalMinutes: config.agent.minWakeIntervalMinutes,
        surfacedLimit: config.agent.surfacedLimit,
        markSurfacedRead: config.agent.markSurfacedRead,
      },
      widget: config.widget,
    }),
  },
});

const typingsSource = path.join(rootDir, 'types', 'nativekit.d.ts.template');
await fs.copyFile(typingsSource, path.join(outDir, 'nativekit.d.ts'));

console.log(`✓ NativeKit bridge: ${path.relative(rootDir, path.join(outDir, 'nativekit.js'))}`);
console.log(`✓ NativeKit typings: ${path.relative(rootDir, path.join(outDir, 'nativekit.d.ts'))}`);
