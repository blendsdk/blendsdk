/**
 * @blendsdk/webafx-pino — Structured logging plugin for WebAFX with Pino.
 *
 * Adapts pino behind the BlendSDK Logger interface. Can be used standalone
 * or as a WebAFX plugin.
 *
 * @packageDocumentation
 */

// ── Types & Constants ────────────────────────────────────────────────────
export {
  DEFAULT_SERVICE_NAME,
  DEFAULT_PLUGIN_PRIORITY,
  DEFAULT_REDACT_PATHS,
  type LoggerProviderConfig,
  type PinoLoggerProviderConfig,
  type PinoLoggerPluginOptions,
} from './types.js';

// ── Abstract Provider ────────────────────────────────────────────────────
export { LoggerProvider } from './abstract-logger-provider.js';

// ── Pino Provider ────────────────────────────────────────────────────────
export { PinoLoggerProvider, normalizeLevel } from './pino-logger-provider.js';

// ── Plugin ───────────────────────────────────────────────────────────────
export { createLoggerPlugin, pinoLoggerPlugin } from './pino-plugin.js';
