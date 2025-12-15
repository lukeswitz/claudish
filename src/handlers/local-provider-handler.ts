/**
 * Local Provider Handler
 *
 * Handles requests to local OpenAI-compatible providers like Ollama, LM Studio, vLLM.
 * Uses the Provider Registry for configuration and shared OpenAI-compat utilities.
 */

import type { Context } from "hono";
import type { ModelHandler } from "./types.js";
import type { LocalProvider } from "../providers/provider-registry.js";
import { AdapterManager } from "../adapters/adapter-manager.js";
import { MiddlewareManager } from "../middleware/index.js";
import { transformOpenAIToClaude } from "../transform.js";
import { log, logStructured } from "../logger.js";
import { writeFileSync, readdirSync, statSync, unlinkSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "undici";
import {
  convertMessagesToOpenAI,
  convertToolsToOpenAI,
  filterIdentity,
  createStreamingResponseHandler,
  estimateTokens,
} from "./shared/openai-compat.js";

// Create a custom undici agent with long timeouts for local LLM inference
// Default undici headersTimeout is 30s which is too short for prompt processing
const localProviderAgent = new Agent({
  headersTimeout: 600000,  // 10 minutes for headers (prompt processing time)
  bodyTimeout: 600000,     // 10 minutes for body (generation time)
  keepAliveTimeout: 30000, // 30 seconds keepalive
  keepAliveMaxTimeout: 600000,
});

// Model metadata cache structure
interface ModelMetadataCache {
  [modelId: string]: {
    contextWindow: number;
    timestamp: number;
    ttl: number; // Time to live in milliseconds
  };
}

// Cache file path
const CACHE_DIR = join(homedir(), '.config', 'claudish');
const CACHE_FILE = join(CACHE_DIR, 'model-cache.json');
const DEFAULT_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days for local models

export interface LocalProviderOptions {
  summarizeTools?: boolean; // Summarize tool descriptions to reduce prompt size
  toolMode?: 'full' | 'standard' | 'essential' | 'ultra-compact'; // Tool filtering mode
}

export class LocalProviderHandler implements ModelHandler {
  private provider: LocalProvider;
  private modelName: string;
  private adapterManager: AdapterManager;
  private middlewareManager: MiddlewareManager;
  private port: number;
  private healthChecked = false;
  private isHealthy = false;
  private contextWindow = 32768; // Default context window (32K reasonable for modern models)
  private sessionInputTokens = 0;
  private sessionOutputTokens = 0;
  private options: LocalProviderOptions;
  private warnedContext80 = false;
  private warnedContext90 = false;
  private pruningEnabled = false; // Track if pruning has been triggered

  // Static health check cache (shared across all instances)
  private static healthCheckCache = new Map<string, { healthy: boolean; timestamp: number }>();
  private static HEALTH_CHECK_TTL = 60000; // 60 seconds

  /**
   * Load model metadata from cache file
   */
  private static loadCachedMetadata(modelId: string): number | null {
    try {
      if (!existsSync(CACHE_FILE)) {
        return null;
      }

      const cacheData = readFileSync(CACHE_FILE, 'utf-8');
      const cache: ModelMetadataCache = JSON.parse(cacheData);
      const entry = cache[modelId];

      if (!entry) {
        return null;
      }

      // Check if cache entry is still valid
      const now = Date.now();
      if (now - entry.timestamp < entry.ttl) {
        return entry.contextWindow;
      }

      // Cache expired
      return null;
    } catch (e) {
      // Ignore cache read errors
      return null;
    }
  }

  /**
   * Save model metadata to cache file
   */
  private static saveCachedMetadata(modelId: string, contextWindow: number): void {
    try {
      // Ensure cache directory exists
      if (!existsSync(CACHE_DIR)) {
        mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
      }

      // Load existing cache or create new
      let cache: ModelMetadataCache = {};
      if (existsSync(CACHE_FILE)) {
        try {
          const cacheData = readFileSync(CACHE_FILE, 'utf-8');
          cache = JSON.parse(cacheData);
        } catch {
          // Invalid cache file, start fresh
          cache = {};
        }
      }

      // Update cache entry
      cache[modelId] = {
        contextWindow,
        timestamp: Date.now(),
        ttl: DEFAULT_CACHE_TTL,
      };

      // Write cache file with restricted permissions
      writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), {
        encoding: 'utf-8',
        mode: 0o600, // Owner read/write only
      });
    } catch (e) {
      // Ignore cache write errors (not critical)
      log(`[LocalProvider] Failed to save model cache: ${e instanceof Error ? e.message : e}`);
    }
  }

  constructor(provider: LocalProvider, modelName: string, port: number, options: LocalProviderOptions = {}) {
    this.provider = provider;
    this.modelName = modelName;
    this.port = port;
    this.options = options;
    this.adapterManager = new AdapterManager(modelName);
    this.middlewareManager = new MiddlewareManager();
    this.middlewareManager.initialize().catch((err) => {
      log(`[LocalProvider:${provider.name}] Middleware init error: ${err}`);
    });

    // Priority order for context window:
    // 1. Environment variable (highest priority - user override)
    // 2. Cached metadata (from previous session)
    // 3. Default value (32K, will be updated on first request)

    // Check for env var override of context window (useful when API doesn't expose it)
    const envContextWindow = process.env.CLAUDISH_CONTEXT_WINDOW;
    if (envContextWindow) {
      const parsed = parseInt(envContextWindow, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.contextWindow = parsed;
        log(`[LocalProvider:${provider.name}] Context window from env: ${this.contextWindow}`);
      }
    } else {
      // Try to load from cache
      const cachedContextWindow = LocalProviderHandler.loadCachedMetadata(this.getCacheKey());
      if (cachedContextWindow) {
        this.contextWindow = cachedContextWindow;
        log(`[LocalProvider:${provider.name}] Context window from cache: ${this.contextWindow} (saved within 7 days)`);
      }
    }

    // Cleanup stale token files on startup
    this.cleanupStaleTokenFiles();

    // Write initial token file so status line has data from the start
    this.writeTokenFile(0, 0);
    if (options.summarizeTools) {
      log(`[LocalProvider:${provider.name}] Tool summarization enabled`);
    }
  }

  /**
   * Generate cache key for this model
   * Format: provider:modelName (e.g., "ollama:qwen2.5-coder:7b")
   */
  private getCacheKey(): string {
    return `${this.provider.name}:${this.modelName}`;
  }

  /**
   * Cleanup stale token files from crashed sessions (>24 hours old)
   */
  private cleanupStaleTokenFiles(): void {
    try {
      const tempDir = tmpdir();
      const files = readdirSync(tempDir);
      const staleThreshold = Date.now() - 86400000; // 24 hours
      let cleanedCount = 0;

      for (const file of files) {
        if (file.startsWith('claudish-tokens-')) {
          const filePath = join(tempDir, file);
          try {
            const stats = statSync(filePath);
            if (stats.mtimeMs < staleThreshold) {
              unlinkSync(filePath);
              cleanedCount++;
            }
          } catch {
            // Ignore errors for individual files
          }
        }
      }

      if (cleanedCount > 0) {
        log(`[LocalProvider:${this.provider.name}] Cleaned up ${cleanedCount} stale token file(s)`);
      }
    } catch (e) {
      // Ignore cleanup errors - not critical
    }
  }

  /**
   * Check if the local provider is available (with 60s cache)
   */
  async checkHealth(): Promise<boolean> {
    if (this.healthChecked) return this.isHealthy;

    // Check cache first
    const now = Date.now();
    const cached = LocalProviderHandler.healthCheckCache.get(this.provider.baseUrl);

    if (cached && (now - cached.timestamp) < LocalProviderHandler.HEALTH_CHECK_TTL) {
      log(`[LocalProvider:${this.provider.name}] Using cached health check (${Math.round((now - cached.timestamp)/1000)}s old)`);
      this.isHealthy = cached.healthy;
      this.healthChecked = true;
      return cached.healthy;
    }

    // Try Ollama-specific health check first
    try {
      const healthUrl = `${this.provider.baseUrl}/api/tags`;
      log(`[LocalProvider:${this.provider.name}] Trying health check: ${healthUrl}`);
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        LocalProviderHandler.healthCheckCache.set(this.provider.baseUrl, { healthy: true, timestamp: now });
        log(`[LocalProvider:${this.provider.name}] Health check passed (/api/tags)`);
        return true;
      }
      log(`[LocalProvider:${this.provider.name}] /api/tags returned ${response.status}, trying /v1/models`);
    } catch (e: any) {
      log(`[LocalProvider:${this.provider.name}] /api/tags failed: ${e?.message || e}, trying /v1/models`);
    }

    // Try generic OpenAI-compatible health check (works for MLX, LM Studio, vLLM, etc.)
    try {
      const modelsUrl = `${this.provider.baseUrl}/v1/models`;
      log(`[LocalProvider:${this.provider.name}] Trying health check: ${modelsUrl}`);
      const response = await fetch(modelsUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        this.isHealthy = true;
        this.healthChecked = true;
        LocalProviderHandler.healthCheckCache.set(this.provider.baseUrl, { healthy: true, timestamp: now });
        log(`[LocalProvider:${this.provider.name}] Health check passed (/v1/models)`);
        return true;
      }
      log(`[LocalProvider:${this.provider.name}] /v1/models returned ${response.status}`);
    } catch (e: any) {
      log(`[LocalProvider:${this.provider.name}] /v1/models failed: ${e?.message || e}`);
    }

    this.healthChecked = true;
    this.isHealthy = false;
    LocalProviderHandler.healthCheckCache.set(this.provider.baseUrl, { healthy: false, timestamp: now });
    log(`[LocalProvider:${this.provider.name}] Health check FAILED - provider not available`);
    return false;
  }

  /**
   * Fetch context window size from provider-specific endpoints
   */
  private async fetchContextWindow(): Promise<void> {
    log(`[LocalProvider:${this.provider.name}] Fetching context window...`);
    if (this.provider.name === "ollama") {
      await this.fetchOllamaContextWindow();
    } else if (this.provider.name === "lmstudio") {
      await this.fetchLMStudioContextWindow();
    } else {
      log(`[LocalProvider:${this.provider.name}] No context window fetch for this provider, using default: ${this.contextWindow}`);
    }
  }

  /**
   * Fetch context window from Ollama's /api/show endpoint
   */
  private async fetchOllamaContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.provider.baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: this.modelName }),
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = await response.json() as any;
        // Ollama returns context window in model_info
        // Can be at general.context_length OR {architecture}.context_length
        let ctxFromInfo = data.model_info?.["general.context_length"];

        // If not found at general.context_length, search for {arch}.context_length
        if (!ctxFromInfo && data.model_info) {
          for (const key of Object.keys(data.model_info)) {
            if (key.endsWith(".context_length")) {
              ctxFromInfo = data.model_info[key];
              break;
            }
          }
        }

        const ctxFromParams = data.parameters?.match(/num_ctx\s+(\d+)/)?.[1];
        if (ctxFromInfo) {
          this.contextWindow = parseInt(String(ctxFromInfo), 10);
        } else if (ctxFromParams) {
          this.contextWindow = parseInt(ctxFromParams, 10);
        } else {
          // Keep class default (32K)
          log(`[LocalProvider:${this.provider.name}] No context info found, using default: ${this.contextWindow}`);
        }
        if (ctxFromInfo || ctxFromParams) {
          log(`[LocalProvider:${this.provider.name}] Context window: ${this.contextWindow}`);
          // Save to cache for future sessions
          LocalProviderHandler.saveCachedMetadata(this.getCacheKey(), this.contextWindow);
        }
      }
    } catch (e) {
      // Use default context window
    }
  }

  /**
   * Fetch context window from LM Studio's /v1/models endpoint
   */
  private async fetchLMStudioContextWindow(): Promise<void> {
    try {
      const response = await fetch(`${this.provider.baseUrl}/v1/models`, {
        method: "GET",
        signal: AbortSignal.timeout(3000),
      });

      if (response.ok) {
        const data = await response.json() as any;
        log(`[LocalProvider:lmstudio] Models response: ${JSON.stringify(data).slice(0, 500)}`);

        // LM Studio returns models in data array
        // Look for the loaded model and check for context_length
        const models = data.data || [];
        // Try exact match first, then path-based match (model names often include org/name)
        const targetModel = models.find((m: any) => m.id === this.modelName) ||
                           models.find((m: any) => m.id?.endsWith(`/${this.modelName}`)) ||
                           models.find((m: any) => this.modelName.includes(m.id));

        if (targetModel) {
          // Check various possible locations for context length
          const ctxLength = targetModel.context_length ||
                           targetModel.max_context_length ||
                           targetModel.context_window ||
                           targetModel.max_tokens;
          if (ctxLength && typeof ctxLength === "number") {
            this.contextWindow = ctxLength;
            log(`[LocalProvider:lmstudio] Context window from model: ${this.contextWindow}`);
            // Save to cache for future sessions
            LocalProviderHandler.saveCachedMetadata(this.getCacheKey(), this.contextWindow);
            return;
          }
        }

        // LM Studio often uses 4096 or 8192 as defaults, but many models support more
        // Use a reasonable default for modern models
        this.contextWindow = 32768;
        log(`[LocalProvider:lmstudio] Using default context window: ${this.contextWindow}`);
        // Save default to cache
        LocalProviderHandler.saveCachedMetadata(this.getCacheKey(), this.contextWindow);
      }
    } catch (e: any) {
      // Use default - LM Studio typically supports at least 4K
      this.contextWindow = 32768;
      log(`[LocalProvider:lmstudio] Failed to fetch model info: ${e?.message || e}. Using default: ${this.contextWindow}`);
      // Save default to cache
      LocalProviderHandler.saveCachedMetadata(this.getCacheKey(), this.contextWindow);
    }
  }

  /**
   * Write token tracking file for status line
   */
  private writeTokenFile(input: number, output: number): void {
    try {
      // For local models, prompt_tokens represents the FULL conversation context each request
      // (not incremental), so we use the latest value directly instead of accumulating.
      // Output tokens ARE incremental (new tokens generated), so we accumulate those.
      if (input > 0) {
        this.sessionInputTokens = input; // Use latest (already includes full context)
      }
      this.sessionOutputTokens += output; // Accumulate outputs
      const sessionTotal = this.sessionInputTokens + this.sessionOutputTokens;

      // Calculate context usage: input (full context) + accumulated outputs
      const leftPct = this.contextWindow > 0
        ? Math.max(0, Math.min(100, Math.round(((this.contextWindow - sessionTotal) / this.contextWindow) * 100)))
        : 100;

      // Context usage warnings
      if (leftPct < 20 && !this.warnedContext80) {
        this.warnedContext80 = true;
        log(`⚠️  [LocalProvider] WARNING: Context usage >80% (${100-leftPct}% used, ${this.contextWindow - sessionTotal} tokens remaining). Consider restarting session.`);
      }

      if (leftPct < 10 && !this.warnedContext90) {
        this.warnedContext90 = true;
        log(`🚨 [LocalProvider] CRITICAL: Context usage >90% (${100-leftPct}% used, ${this.contextWindow - sessionTotal} tokens remaining). Next request may fail.`);
      }

      const data = {
        input_tokens: this.sessionInputTokens,
        output_tokens: this.sessionOutputTokens,
        total_tokens: sessionTotal,
        total_cost: 0, // Local models are free
        context_window: this.contextWindow,
        context_left_percent: leftPct,
        updated_at: Date.now(),
      };

      writeFileSync(
        join(tmpdir(), `claudish-tokens-${this.port}.json`),
        JSON.stringify(data),
        "utf-8"
      );
    } catch (e) {
      // Ignore write errors
    }
  }

  /**
   * Prune conversation history when context usage is high
   * Preserves: system messages, first user message, recent messages, and tool call/result pairs
   */
  private pruneConversationHistory(messages: any[]): { pruned: any[]; removedCount: number } {
    if (messages.length <= 5) {
      // Too few messages to prune meaningfully
      return { pruned: messages, removedCount: 0 };
    }

    const preserved: any[] = [];
    const toRemove: number[] = [];

    // 1. Preserve system message (first message if system role)
    if (messages.length > 0 && messages[0].role === "system") {
      preserved.push(messages[0]);
    }

    // Find first user message index (after system message if present)
    const firstUserIdx = messages.findIndex((m, i) =>
      m.role === "user" && (i === 0 || messages[0].role !== "system" || i > 0)
    );

    // 2. Preserve first user message
    if (firstUserIdx !== -1 && firstUserIdx > 0) {
      preserved.push({ ...messages[firstUserIdx], __preservedIndex: firstUserIdx });
    }

    // 3. Preserve recent messages (last 12 messages to keep good context)
    const recentStartIdx = Math.max(0, messages.length - 12);
    const recentMessages = messages.slice(recentStartIdx).map((m, i) => ({
      ...m,
      __preservedIndex: recentStartIdx + i
    }));

    // 4. Identify middle section to prune (between first user msg and recent msgs)
    const middleStartIdx = firstUserIdx !== -1 ? firstUserIdx + 1 : (messages[0].role === "system" ? 1 : 0);
    const middleEndIdx = recentStartIdx;

    // Build a list of indices that form tool call/result pairs in the middle section
    const preservedPairs = new Set<number>();

    for (let i = middleStartIdx; i < middleEndIdx; i++) {
      const msg = messages[i];

      // If assistant message has tool_calls, preserve it and following tool messages
      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        preservedPairs.add(i);

        // Find corresponding tool result messages
        const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));

        // Look ahead for tool results (usually immediately following)
        for (let j = i + 1; j < middleEndIdx && j < i + 10; j++) {
          const nextMsg = messages[j];
          if (nextMsg.role === "tool" && toolCallIds.has(nextMsg.tool_call_id)) {
            preservedPairs.add(j);
          } else if (nextMsg.role === "assistant" || nextMsg.role === "user") {
            // Stop looking when we hit next turn
            break;
          }
        }
      }
    }

    // Sample some preserved tool pairs to keep conversation continuity (every 3rd pair)
    const pairIndices = Array.from(preservedPairs).sort((a, b) => a - b);
    const sampledPairs = new Set<number>();
    for (let i = 0; i < pairIndices.length; i += 3) {
      // Keep first pair in each group of 3
      sampledPairs.add(pairIndices[i]);
      // Find associated tool results
      const msg = messages[pairIndices[i]];
      if (msg.role === "assistant" && msg.tool_calls) {
        const toolCallIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
        for (let j = pairIndices[i] + 1; j < middleEndIdx; j++) {
          const nextMsg = messages[j];
          if (nextMsg.role === "tool" && toolCallIds.has(nextMsg.tool_call_id)) {
            sampledPairs.add(j);
          }
        }
      }
    }

    // Mark messages for removal (middle section, excluding sampled pairs)
    for (let i = middleStartIdx; i < middleEndIdx; i++) {
      if (!sampledPairs.has(i)) {
        toRemove.push(i);
      }
    }

    // Build final pruned array
    const preservedIndices = new Set([
      ...(messages[0]?.role === "system" ? [0] : []),
      ...(firstUserIdx > 0 ? [firstUserIdx] : []),
      ...Array.from(sampledPairs),
      ...Array.from({ length: messages.length - recentStartIdx }, (_, i) => recentStartIdx + i)
    ]);

    const pruned = messages.filter((_, idx) => preservedIndices.has(idx));
    const removedCount = messages.length - pruned.length;

    if (removedCount > 0) {
      log(`[LocalProvider] Pruned conversation history: ${messages.length} → ${pruned.length} messages (removed ${removedCount})`);
      log(`[LocalProvider] Preserved: system msg, first user msg, ${sampledPairs.size} sampled interactions, ${messages.length - recentStartIdx} recent msgs`);
    }

    return { pruned, removedCount };
  }

  async handle(c: Context, payload: any): Promise<Response> {
    const target = this.modelName;

    logStructured(`LocalProvider Request`, {
      provider: this.provider.name,
      targetModel: target,
      originalModel: payload.model,
      baseUrl: this.provider.baseUrl,
    });

    // Health check on first request
    if (!this.healthChecked) {
      const healthy = await this.checkHealth();
      if (!healthy) {
        return this.errorResponse(c, "connection_error", this.getConnectionErrorMessage());
      }
      // Fetch context window after successful health check
      await this.fetchContextWindow();
    }

    // Transform request
    const { claudeRequest, droppedParams } = transformOpenAIToClaude(payload);
    // Use simple format for providers that don't support complex message structures
    // MLX doesn't handle array content or tool role messages
    const useSimpleFormat = this.provider.name === "mlx";
    let messages = convertMessagesToOpenAI(claudeRequest, target, filterIdentity, useSimpleFormat);
    const toolMode = this.options.toolMode || (this.options.summarizeTools ? 'standard' : 'full');
    const tools = convertToolsToOpenAI(claudeRequest, this.options.summarizeTools, toolMode);

    // Check for context pruning (when context usage > 80%)
    const sessionTotal = this.sessionInputTokens + this.sessionOutputTokens;
    const contextUsagePercent = this.contextWindow > 0
      ? ((sessionTotal / this.contextWindow) * 100)
      : 0;

    let pruningOccurred = false;
    if (contextUsagePercent > 80 && !this.pruningEnabled && messages.length > 5) {
      log(`[LocalProvider] Context usage at ${contextUsagePercent.toFixed(1)}% - triggering conversation pruning`);
      const result = this.pruneConversationHistory(messages);
      if (result.removedCount > 0) {
        messages = result.pruned;
        pruningOccurred = true;
        this.pruningEnabled = true;

        // Estimate token savings (rough: ~150 tokens per message on average)
        const estimatedSavings = result.removedCount * 150;
        log(`[LocalProvider] Pruning complete - estimated ${estimatedSavings} tokens saved`);
      }
    }

    // Check capability: strip tools if not supported
    const finalTools = this.provider.capabilities.supportsTools ? tools : [];
    if (tools.length > 0 && !this.provider.capabilities.supportsTools) {
      log(`[LocalProvider:${this.provider.name}] Tools stripped (not supported)`);
    }
    if (tools.length > 0 && (this.options.summarizeTools || this.options.toolMode)) {
      log(`[LocalProvider:${this.provider.name}] Tools processed: ${tools.length} tools, mode=${toolMode}`);
    }

    // Add compact guidance to system prompt for local models (optimized to ~200 tokens)
    if (messages.length > 0 && messages[0].role === "system") {
      // Check if this is a Qwen model that needs explicit tool format instructions
      const isQwen = target.toLowerCase().includes("qwen");

      // Add pruning notice if it occurred
      const pruningNotice = pruningOccurred
        ? `\n\nNOTE: Conversation history has been automatically pruned to manage context window usage (${contextUsagePercent.toFixed(0)}% full). Some older messages have been removed to prevent context overflow. Recent context and important tool interactions have been preserved.`
        : '';

      // Ultra-compact guidance (~200 tokens vs original ~500 tokens)
      let guidance = `

CRITICAL INSTRUCTIONS:
1. NO internal reasoning/thinking as visible text - only output final response or tool calls
2. ALWAYS continue after tool results - analyze data and take next action toward user's request
3. For tool calls: use OpenAI JSON format, NOT XML/text
${isQwen ? '4. Qwen: Use API tool_calls mechanism, NOT <function=...> text format\n' : ''}${finalTools.length > 0 ? `${isQwen ? '5' : '4'}. Include ALL required parameters in tool calls (incomplete calls fail)` : ''}${pruningNotice}`;

      messages[0].content += guidance;
    }

    // Detect model family for optimized sampling parameters
    const modelLower = target.toLowerCase();
    const isQwenModel = modelLower.includes("qwen");
    const isDeepSeekModel = modelLower.includes("deepseek");
    const isLlamaModel = modelLower.includes("llama");
    const isMistralModel = modelLower.includes("mistral");

    // Hardcoded recommended sampling parameters per model family
    // These are optimized defaults - no env vars needed
    const getSamplingParams = () => {
      if (isQwenModel) {
        // Qwen3 Instruct recommended settings
        // Source: Qwen team + community testing for thinking mode stability
        return {
          temperature: 0.7,
          top_p: 0.8,
          top_k: 20,
          min_p: 0.0,
          repetition_penalty: 1.05,  // Slight penalty helps with Qwen repetition
        };
      }
      if (isDeepSeekModel) {
        // DeepSeek Coder recommended settings
        return {
          temperature: 0.6,
          top_p: 0.95,
          top_k: 40,
          min_p: 0.0,
          repetition_penalty: 1.0,
        };
      }
      if (isLlamaModel) {
        // Llama 3.x recommended settings
        return {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 40,
          min_p: 0.05,
          repetition_penalty: 1.1,
        };
      }
      if (isMistralModel) {
        // Mistral recommended settings
        return {
          temperature: 0.7,
          top_p: 0.9,
          top_k: 50,
          min_p: 0.0,
          repetition_penalty: 1.0,
        };
      }
      // Generic defaults for other models
      return {
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        min_p: 0.0,
        repetition_penalty: 1.0,
      };
    };

    // Get model-specific defaults, then override with env vars if present
    const defaultParams = getSamplingParams();

    // Apply environment variable overrides (allows user customization)
    const samplingParams = {
      temperature: parseFloat(process.env.CLAUDISH_TEMPERATURE || String(defaultParams.temperature)),
      top_p: parseFloat(process.env.CLAUDISH_TOP_P || String(defaultParams.top_p)),
      top_k: parseInt(process.env.CLAUDISH_TOP_K || String(defaultParams.top_k), 10),
      min_p: parseFloat(process.env.CLAUDISH_MIN_P || String(defaultParams.min_p)),
      repetition_penalty: parseFloat(process.env.CLAUDISH_REP_PENALTY || process.env.CLAUDISH_REPETITION_PENALTY || String(defaultParams.repetition_penalty)),
    };

    // Log if env vars were used
    const hasEnvOverrides = process.env.CLAUDISH_TEMPERATURE || process.env.CLAUDISH_TOP_P ||
                            process.env.CLAUDISH_TOP_K || process.env.CLAUDISH_MIN_P ||
                            process.env.CLAUDISH_REP_PENALTY || process.env.CLAUDISH_REPETITION_PENALTY;
    if (hasEnvOverrides) {
      log(`[LocalProvider:${this.provider.name}] Using env var overrides for sampling params`);
    }
    log(`[LocalProvider:${this.provider.name}] Sampling: temp=${samplingParams.temperature}, top_p=${samplingParams.top_p}, top_k=${samplingParams.top_k}, rep=${samplingParams.repetition_penalty}`);

    // For local providers, ensure max_tokens is set to a reasonable value
    // Some local providers have very low defaults or ignore Claude's max_tokens
    // Use the larger of: Claude's request, 8192 minimum for meaningful responses
    const requestedMaxTokens = claudeRequest.max_tokens || 4096;
    const effectiveMaxTokens = Math.max(requestedMaxTokens, 8192);

    log(`[LocalProvider:${this.provider.name}] max_tokens: requested=${requestedMaxTokens}, effective=${effectiveMaxTokens}`);

    // Build OpenAI-compatible payload
    const openAIPayload: any = {
      model: target,
      messages,
      // Sampling params - optimized per model family
      // Critical to avoid infinite loops with Qwen3 thinking mode
      temperature: samplingParams.temperature,
      top_p: samplingParams.top_p,
      top_k: samplingParams.top_k,
      min_p: samplingParams.min_p,
      repetition_penalty: samplingParams.repetition_penalty > 1 ? samplingParams.repetition_penalty : undefined,
      stream: this.provider.capabilities.supportsStreaming,
      max_tokens: effectiveMaxTokens,
      tools: finalTools.length > 0 ? finalTools : undefined,
      stream_options: this.provider.capabilities.supportsStreaming ? { include_usage: true } : undefined,
      // Note: Removed stop sequences - they can cause premature termination
      // The chat template should handle turn boundaries naturally
    };

    // For Qwen models: add /no_think to disable thinking mode if causing issues
    // This can be toggled by setting CLAUDISH_QWEN_NO_THINK=1
    if (isQwenModel && process.env.CLAUDISH_QWEN_NO_THINK === "1") {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = "/no_think\n\n" + messages[0].content;
        log(`[LocalProvider:${this.provider.name}] Added /no_think to disable Qwen thinking mode`);
      }
    }

    // For Ollama: set context window size to ensure tools aren't truncated
    // This is critical - Ollama defaults to 2048 and silently truncates, losing tool definitions!
    // Also enable prompt caching via keep_alive for faster follow-up requests
    if (this.provider.name === "ollama") {
      // Use detected context window, or 32K minimum for tool calling (Claude Code sends large system prompts)
      const numCtx = Math.max(this.contextWindow, 32768);
      const keepAlive = process.env.CLAUDISH_OLLAMA_KEEP_ALIVE || "30m";
      openAIPayload.options = {
        num_ctx: numCtx,
        keep_alive: keepAlive  // Keep model + KV cache in memory for faster requests
      };
      log(`[LocalProvider:${this.provider.name}] Setting num_ctx: ${numCtx} (detected: ${this.contextWindow}), keep_alive: ${keepAlive}`);
    }

    // Handle tool choice
    if (claudeRequest.tool_choice && finalTools.length > 0) {
      const { type, name } = claudeRequest.tool_choice;
      if (type === "tool" && name) {
        openAIPayload.tool_choice = { type: "function", function: { name } };
      } else if (type === "auto" || type === "none") {
        openAIPayload.tool_choice = type;
      }
    }

    // Apply adapter transformations
    const adapter = this.adapterManager.getAdapter();
    if (typeof adapter.reset === "function") adapter.reset();
    adapter.prepareRequest(openAIPayload, claudeRequest);

    // Strip parameters that local providers don't support
    // These are cloud-API-specific (e.g., Qwen API's enable_thinking, thinking_budget)
    // LM Studio, Ollama, etc. don't understand these and may behave unexpectedly
    delete openAIPayload.enable_thinking;
    delete openAIPayload.thinking_budget;
    delete openAIPayload.thinking;

    // Apply middleware
    await this.middlewareManager.beforeRequest({
      modelId: target,
      messages,
      tools: finalTools,
      stream: openAIPayload.stream,
    });

    // Make request to local provider
    const apiUrl = `${this.provider.baseUrl}${this.provider.apiPath}`;

    // Debug logging (only to file, not console)
    log(`[LocalProvider:${this.provider.name}] Request: ${openAIPayload.tools?.length || 0} tools, ${messages.length} messages`);
    log(`[LocalProvider:${this.provider.name}] Endpoint: ${apiUrl}`);

    try {
      // Use a long timeout for local providers - they need time for prompt processing
      // before sending response headers. Default undici timeout is ~30s which is too short
      // for large prompts on local models.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        log(`[LocalProvider:${this.provider.name}] Request timeout (10 min) - aborting`);
        controller.abort();
      }, 600000); // 10 minutes - local models can be slow

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(openAIPayload),
        signal: controller.signal,
        // @ts-ignore - Use custom undici agent with long timeouts for local LLM inference
        dispatcher: localProviderAgent,
      });

      clearTimeout(timeoutId);

      log(`[LocalProvider:${this.provider.name}] Response status: ${response.status}`);
      if (!response.ok) {
        const errorBody = await response.text();
        log(`[LocalProvider:${this.provider.name}] ERROR: ${errorBody.slice(0, 200)}`);
        return this.handleErrorResponse(c, response.status, errorBody);
      }

      log(`[LocalProvider:${this.provider.name}] Response OK, proceeding to streaming...`);
      if (droppedParams.length > 0) {
        c.header("X-Dropped-Params", droppedParams.join(", "));
      }

      // Handle streaming response
      log(`[LocalProvider:${this.provider.name}] Streaming: ${openAIPayload.stream}`);
      if (openAIPayload.stream) {
        return createStreamingResponseHandler(
          c,
          response,
          adapter,
          target,
          this.middlewareManager,
          (input, output) => this.writeTokenFile(input, output),
          claudeRequest.tools  // Pass tool schemas for validation
        );
      }

      // Handle non-streaming response (shouldn't normally happen)
      const data = await response.json();
      return c.json(data);
    } catch (error: any) {
      if (error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED") {
        return this.errorResponse(c, "connection_error", this.getConnectionErrorMessage());
      }
      throw error;
    }
  }

  private handleErrorResponse(c: Context, status: number, errorBody: string): Response {
    // Parse error and provide helpful messages
    try {
      const parsed = JSON.parse(errorBody);
      const errorMsg = parsed.error?.message || parsed.error || errorBody;

      // Model not found
      if (errorMsg.includes("model") && (errorMsg.includes("not found") || errorMsg.includes("does not exist"))) {
        return this.errorResponse(
          c,
          "model_not_found",
          `Model '${this.modelName}' not found. ${this.getModelPullHint()}`
        );
      }

      // Model doesn't support tools - provide helpful message
      if (errorMsg.includes("does not support tools") || errorMsg.includes("tool") && errorMsg.includes("not supported")) {
        return this.errorResponse(
          c,
          "capability_error",
          `Model '${this.modelName}' does not support tool/function calling. Claude Code requires tool support for most operations. Try a model that supports tools (e.g., llama3.2, mistral, qwen2.5).`,
          400
        );
      }

      return this.errorResponse(c, "api_error", errorMsg, status);
    } catch {
      return this.errorResponse(c, "api_error", errorBody, status);
    }
  }

  private errorResponse(c: Context, type: string, message: string, status: number = 503): Response {
    return c.json(
      {
        error: {
          type,
          message,
        },
      },
      status as any
    );
  }

  private getConnectionErrorMessage(): string {
    switch (this.provider.name) {
      case "ollama":
        return `Cannot connect to Ollama at ${this.provider.baseUrl}. Make sure Ollama is running with: ollama serve`;
      case "lmstudio":
        return `Cannot connect to LM Studio at ${this.provider.baseUrl}. Make sure LM Studio server is running.`;
      case "vllm":
        return `Cannot connect to vLLM at ${this.provider.baseUrl}. Make sure vLLM server is running.`;
      default:
        return `Cannot connect to ${this.provider.name} at ${this.provider.baseUrl}. Make sure the server is running.`;
    }
  }

  private getModelPullHint(): string {
    switch (this.provider.name) {
      case "ollama":
        return `Pull it with: ollama pull ${this.modelName}`;
      default:
        return "Make sure the model is available on the server.";
    }
  }

  async shutdown(): Promise<void> {}
}
