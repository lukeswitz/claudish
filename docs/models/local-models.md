# Local Models Guide

**Run Claude Code offline with Ollama, LM Studio, and other local providers.**

Claudish supports running models locally on your machine through OpenAI-compatible providers. This guide covers setup, model selection, and optimization.

---

## Supported Providers

### Ollama (Recommended)
**Installation:** [ollama.com](https://ollama.com)

```bash
# Install and run Ollama
ollama serve

# Pull a model
ollama pull qwen2.5-coder:7b

# Use with Claudish
claudish --model ollama/qwen2.5-coder:7b "your prompt"
```

**Pros:** Easy setup, good model library, automatic updates
**Cons:** Requires dedicated server process

### LM Studio
**Installation:** [lmstudio.ai](https://lmstudio.ai)

```bash
# Start LM Studio server, then:
claudish --model lmstudio/model-name "your prompt"
```

**Pros:** GUI, easy model management, good for beginners
**Cons:** Manual model downloads, larger memory footprint

### vLLM / MLX
**Advanced users only.** See [advanced/custom-providers.md](../advanced/custom-providers.md)

---

## Understanding Quantization

**Quantization** reduces model size by using lower precision numbers. This is critical for running models locally.

### Quantization Levels Explained

| Level | Precision | RAM per 7B | Quality | Best For |
|-------|-----------|------------|---------|----------|
| **Q2_K** | 2-bit | ~2.5GB | 70-80% | Experimentation only |
| **Q4_K_M** | 4-bit medium | ~4.5GB | **95-98%** | **Daily use (recommended)** |
| **Q5_K_M** | 5-bit medium | ~5.5GB | 97-99% | Complex reasoning |
| **Q8_0** | 8-bit | ~8GB | 99%+ | Production, ample RAM |
| **F16** | 16-bit float | ~14GB | 100% (reference) | Research, benchmarking |

**TL;DR: Use Q4_K_M unless you have a specific reason not to.**

### How to Choose

**Q2_K (2-bit)**
- Use for: Testing if a model fits your use case before downloading larger version
- Avoid for: Any real work (quality loss too high)
- RAM needed: ~2.5GB per 7B model

**Q4_K_M (4-bit medium) - RECOMMENDED**
- Use for: Daily coding tasks, most users
- Quality: 95-98% of full precision (imperceptible difference for most tasks)
- RAM needed: ~4.5GB per 7B model
- **This is the sweet spot for local LLMs**

**Q5_K_M (5-bit medium)**
- Use for: Complex reasoning where quality matters more than speed
- Quality: 97-99% of full precision
- RAM needed: ~5.5GB per 7B model
- Trade-off: 20-30% slower than Q4_K_M for marginal quality gain

**Q8_0 (8-bit)**
- Use for: Production deployments, final output generation
- Quality: 99%+ of full precision
- RAM needed: ~8GB per 7B model
- Trade-off: 50-70% slower than Q4_K_M

**F16 (16-bit float)**
- Use for: Research, model evaluation, benchmarking
- Quality: 100% (this is the reference)
- RAM needed: ~14GB per 7B model
- Trade-off: 2-3x slower than Q4_K_M, not worth it for daily use

### Quantization in Practice

```bash
# Recommended: Q4_K_M for daily use
ollama pull qwen2.5-coder:7b-q4_k_m

# Higher quality: Q5_K_M for complex tasks
ollama pull qwen2.5-coder:7b-q5_k_m

# Budget mode: Q4_K_M is still good
ollama pull llama3.2:3b-q4_k_m

# Max quality (large downloads): Q8_0
ollama pull qwen2.5-coder:14b-q8_0
```

**Note:** If quantization isn't specified, Ollama typically uses Q4_0 or Q4_K_M by default.

---

## Recommended Local Models

### Best All-Around: Qwen 2.5 Coder

```bash
# 7B model - Good for 16GB+ RAM
ollama pull qwen2.5-coder:7b
claudish --model ollama/qwen2.5-coder:7b

# 14B model - Good for 32GB+ RAM
ollama pull qwen2.5-coder:14b
claudish --model ollama/qwen2.5-coder:14b

# 32B model - Good for 64GB+ RAM
ollama pull qwen2.5-coder:32b
claudish --model ollama/qwen2.5-coder:32b
```

**Why Qwen 2.5 Coder:**
- Specifically trained for code generation
- Excellent tool calling support
- Good instruction following
- Wide context window support

### Budget Option: Llama 3.2

```bash
# 3B model - Good for 8GB+ RAM
ollama pull llama3.2:3b
claudish --model ollama/llama3.2:3b
```

**Why Llama 3.2:**
- Small but capable
- Fast inference
- Good for simple tasks
- Lower resource requirements

### Alternative: DeepSeek Coder

```bash
# 6.7B model - Good for 16GB+ RAM
ollama pull deepseek-coder:6.7b
claudish --model ollama/deepseek-coder:6.7b
```

**Why DeepSeek Coder:**
- Strong coding performance
- Good at following complex instructions
- Competitive with larger models

---

## Hardware Requirements

### System RAM Guidelines

| Available RAM | Recommended Model Size | Example Models |
|---------------|------------------------|----------------|
| 8GB | 1B-3B (Q4_K_M) | llama3.2:3b, phi-3:3b |
| 16GB | 3B-7B (Q4_K_M) | qwen2.5-coder:7b, llama3.2:3b |
| 32GB | 7B-14B (Q5_K_M) or 32B (Q4_K_M) | qwen2.5-coder:14b |
| 64GB | 14B-32B (Q5_K_M) or 70B (Q4_K_M) | qwen2.5-coder:32b |
| 128GB+ | 32B-70B (Q8_0) or 236B (Q4_K_M) | deepseek-coder-v2:236b |

**Important:** These are guidelines for the model weights only. Your OS and other applications need RAM too. Leave at least 4-8GB free for the system.

### GPU Acceleration

**With NVIDIA GPU:**
- Ollama automatically uses GPU acceleration via CUDA
- Dramatically faster inference (5-10x speedup typical)
- Allows running larger models or higher quantization
- Verify: `nvidia-smi` should show GPU usage when generating

**With Apple Silicon (M1/M2/M3):**
- Ollama uses Metal for GPU acceleration
- Excellent performance on Mac
- Unified memory helps with large models

**CPU Only:**
- Still works, just slower
- Use smaller models (3B-7B) and lower quantization (Q4_K_M)
- Expect 2-10 tokens/sec depending on hardware

---

## Optimization Tips

### 1. Lite Mode for Low-Resource Models

For 8K-32K context models, use the `--lite` preset:

```bash
claudish --lite --model ollama/qwen2.5-coder:7b "task"
```

This automatically enables:
- Ultra-compact tool descriptions
- Essential tools only
- Optimized sampling parameters

### 2. Context Window Optimization

Claudish automatically detects and uses your model's context window. Override if needed:

```bash
export CLAUDISH_CONTEXT_WINDOW=32768
claudish --model ollama/qwen2.5-coder:7b
```

### 3. Performance Metrics

Track tokens/sec and latency:

```bash
export CLAUDISH_SHOW_METRICS=1
claudish --model ollama/qwen2.5-coder:7b
```

Output:
```
📊 [Performance] Current: 12.3 tok/s | Avg: 11.8 tok/s | TTFT: 450ms | Requests: 5
```

### 4. Sampling Parameter Tuning

Adjust model behavior via environment variables:

```bash
# Lower temperature for more focused code generation
export CLAUDISH_TEMPERATURE=0.5

# Higher top_p for more creative solutions
export CLAUDISH_TOP_P=0.95

# Lower top_k for more focused outputs
export CLAUDISH_TOP_K=20

# Repetition penalty to prevent loops
export CLAUDISH_REP_PENALTY=1.1
```

**Default parameters are optimized per model family.** Only adjust if you have a specific need.

---

## Common Issues

### Model Loading Slowly

**First request is always slow (5-30 seconds)** - this is normal. The model needs to load into RAM.

Subsequent requests are fast. Ollama keeps models in memory for 5 minutes by default.

Extend this with:
```bash
export CLAUDISH_OLLAMA_KEEP_ALIVE=30m
```

### Out of Memory Errors

**Try these in order:**
1. Use a smaller model (14B → 7B → 3B)
2. Use lower quantization (Q8_0 → Q5_K_M → Q4_K_M)
3. Close other applications to free RAM
4. Reduce context window: `export CLAUDISH_CONTEXT_WINDOW=16384`

### Context Limit Reached

Claudish automatically prunes conversation history when context usage exceeds 80%. If you still hit limits:

```bash
# Reduce max output tokens
claudish --max-tokens 2048 --model ollama/model
```

Or restart the session to clear context.

### Slow Inference Speed

**Expected speeds:**
- CPU only: 2-10 tok/s (7B model)
- GPU accelerated: 15-50 tok/s (7B model)
- Apple Silicon: 20-60 tok/s (7B model)

**If slower than expected:**
1. Check GPU usage (`nvidia-smi` or Activity Monitor)
2. Use smaller model or lower quantization
3. Ensure Ollama has latest version
4. Close background applications

---

## Disk Space Requirements

Plan for model storage:

| Model Size | Q4_K_M | Q5_K_M | Q8_0 | F16 |
|------------|--------|--------|------|-----|
| 3B | ~2GB | ~2.5GB | ~3.5GB | ~6GB |
| 7B | ~4GB | ~5GB | ~7GB | ~13GB |
| 14B | ~8GB | ~10GB | ~14GB | ~26GB |
| 32B | ~18GB | ~23GB | ~32GB | ~60GB |
| 70B | ~39GB | ~49GB | ~70GB | ~130GB |

**Recommendation:** Start with 1-2 models. Delete unused models with `ollama rm model-name`.

---

## Next Steps

- **[Model Mapping](model-mapping.md)** - Use different models for different tasks
- **[Advanced: Custom Providers](../advanced/custom-providers.md)** - vLLM, MLX, and more
- **[Troubleshooting](../troubleshooting.md)** - Fix common local model issues
