import { app, registeredExtensions } from './mock-obsidian';
import StoryEnginePlugin from '../src/main';
import * as seExport from '../src/export';
(window as any).__seExport = seExport;
(window as any).boot = async (files: Record<string, string>) => {
  for (const [p, d] of Object.entries(files)) await app.vault.create(p, d);
  const plugin = new StoryEnginePlugin(app as any, { id: 'story-engine' });
  (window as any).plugin = plugin;
  await plugin.onload();
  await new Promise(r => setTimeout(r, 50));
  return registeredExtensions.length;
};
