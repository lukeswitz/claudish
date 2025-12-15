/**
 * System Resource Detection
 *
 * Detects available system resources (RAM, GPU, CPU) to help users
 * choose appropriate local models for their hardware.
 */

import { execSync } from 'node:child_process';
import { totalmem, freemem, cpus } from 'node:os';

export interface SystemResources {
  totalRAM: number;        // GB
  availableRAM: number;    // GB
  hasGPU: boolean;
  gpuVRAM?: number;        // GB (if detectable)
  gpuName?: string;        // GPU model name
  cpuCores: number;
  cpuModel: string;
}

/**
 * Detect GPU via nvidia-smi (NVIDIA GPUs only)
 */
function detectNvidiaGPU(): { hasGPU: boolean; gpuVRAM?: number; gpuName?: string } {
  try {
    // Try to get GPU memory in MB
    const vramOutput = execSync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (vramOutput) {
      const vramMB = parseInt(vramOutput.split('\n')[0], 10);
      const vramGB = vramMB / 1024;

      // Get GPU name
      try {
        const nameOutput = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', {
          encoding: 'utf-8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();

        const gpuName = nameOutput.split('\n')[0];
        return { hasGPU: true, gpuVRAM: vramGB, gpuName };
      } catch {
        return { hasGPU: true, gpuVRAM: vramGB };
      }
    }
  } catch {
    // nvidia-smi not available or failed
  }

  return { hasGPU: false };
}

/**
 * Detect AMD GPU via rocm-smi (AMD GPUs only)
 */
function detectAMDGPU(): { hasGPU: boolean; gpuName?: string } {
  try {
    // Try to detect ROCm/AMD GPU
    const output = execSync('rocm-smi --showproductname', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    if (output && output.includes('GPU')) {
      // Extract GPU name from output
      const lines = output.split('\n');
      const gpuLine = lines.find(line => line.includes('GPU'));
      const gpuName = gpuLine?.split(':')[1]?.trim();

      return { hasGPU: true, gpuName };
    }
  } catch {
    // rocm-smi not available or failed
  }

  return { hasGPU: false };
}

/**
 * Detect Apple Silicon GPU (M1/M2/M3/M4)
 */
function detectAppleSiliconGPU(): { hasGPU: boolean; gpuName?: string } {
  try {
    if (process.platform === 'darwin') {
      const output = execSync('sysctl -n machdep.cpu.brand_string', {
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      // Check if it's Apple Silicon (M1/M2/M3/M4)
      if (output.includes('Apple M1') || output.includes('Apple M2') ||
          output.includes('Apple M3') || output.includes('Apple M4')) {
        return { hasGPU: true, gpuName: `${output} (Integrated)` };
      }
    }
  } catch {
    // sysctl not available or failed
  }

  return { hasGPU: false };
}

/**
 * Detect system resources
 */
export async function detectSystemResources(): Promise<SystemResources> {
  // RAM detection
  const totalRAM = totalmem() / (1024 ** 3); // Convert bytes to GB
  const freeRAM = freemem() / (1024 ** 3);
  const availableRAM = freeRAM;

  // CPU detection
  const cpuList = cpus();
  const cpuCores = cpuList.length;
  const cpuModel = cpuList[0]?.model || 'Unknown';

  // GPU detection (try multiple methods)
  let gpuInfo = detectNvidiaGPU();
  if (!gpuInfo.hasGPU) {
    gpuInfo = detectAppleSiliconGPU();
  }
  if (!gpuInfo.hasGPU) {
    gpuInfo = detectAMDGPU();
  }

  return {
    totalRAM,
    availableRAM,
    hasGPU: gpuInfo.hasGPU,
    gpuVRAM: gpuInfo.gpuVRAM,
    gpuName: gpuInfo.gpuName,
    cpuCores,
    cpuModel,
  };
}

/**
 * Print system resources in a user-friendly format
 */
export async function printSystemResources(): Promise<void> {
  const resources = await detectSystemResources();

  console.log('\n' + '='.repeat(70));
  console.log('💻 System Resources for Local LLMs');
  console.log('='.repeat(70));

  console.log('\n📊 Memory:');
  console.log(`   Total RAM:     ${resources.totalRAM.toFixed(1)} GB`);
  console.log(`   Available RAM: ${resources.availableRAM.toFixed(1)} GB`);

  console.log('\n🔧 CPU:');
  console.log(`   Cores:  ${resources.cpuCores}`);
  console.log(`   Model:  ${resources.cpuModel}`);

  console.log('\n🎮 GPU:');
  if (resources.hasGPU) {
    console.log(`   Status: ✅ Detected`);
    if (resources.gpuName) {
      console.log(`   Model:  ${resources.gpuName}`);
    }
    if (resources.gpuVRAM) {
      console.log(`   VRAM:   ${resources.gpuVRAM.toFixed(1)} GB`);
    }
  } else {
    console.log(`   Status: ❌ No GPU detected (CPU-only mode)`);
  }

  console.log('\n' + '='.repeat(70));
  console.log('💡 Tip: Use --check-system to see recommended models for your hardware');
  console.log('='.repeat(70) + '\n');
}

/**
 * Recommend model sizes based on available resources
 */
export function recommendModelSize(resources: SystemResources): string {
  const availableRAM = resources.availableRAM;

  if (availableRAM < 8) {
    return '1B-3B models (Q4_K_M quantization)\n   Examples: qwen2.5-coder:1.5b, phi-3:3b, llama3.2:3b';
  } else if (availableRAM < 16) {
    return '3B-7B models (Q4_K_M)\n   Examples: qwen2.5-coder:7b, llama3.2:7b, mistral:7b';
  } else if (availableRAM < 32) {
    if (resources.hasGPU) {
      return '7B-14B models (Q5_K_M) or 32B models (Q4_K_M)\n   Examples: qwen2.5-coder:14b, deepseek-coder:6.7b, codestral:22b';
    }
    return '7B-14B models (Q4_K_M)\n   Examples: qwen2.5-coder:14b, deepseek-coder:6.7b, codellama:13b';
  } else if (availableRAM < 64) {
    return '14B-32B models (Q5_K_M)\n   Examples: qwen2.5-coder:32b, codestral:22b, mixtral:8x7b';
  } else {
    return '32B-70B models (Q4_K_M or higher)\n   Examples: qwen2.5-coder:72b, deepseek-coder-v2:236b, llama3.1:70b';
  }
}

// Curated list of local models that work well with Claude Code
export const RECOMMENDED_LOCAL_MODELS = [
  {
    name: 'Qwen 2.5 Coder 7B',
    ollama: 'qwen2.5-coder:7b',
    size: '7B',
    quantization: 'Q4_K_M',
    ram: '8GB+',
    diskSpace: '4.5GB',
    description: 'Best all-around coding model - strong tool calling, good instruction following',
    useCase: 'General coding, debugging, refactoring',
  },
  {
    name: 'Qwen 2.5 Coder 14B',
    ollama: 'qwen2.5-coder:14b',
    size: '14B',
    quantization: 'Q4_K_M',
    ram: '16GB+',
    diskSpace: '8.5GB',
    description: 'Higher quality than 7B, better for complex tasks',
    useCase: 'Complex refactoring, architecture decisions',
  },
  {
    name: 'Llama 3.2 3B',
    ollama: 'llama3.2:3b',
    size: '3B',
    quantization: 'Q4_K_M',
    ram: '6GB+',
    diskSpace: '2GB',
    description: 'Budget option - fast and efficient for simple tasks',
    useCase: 'Quick fixes, simple code generation',
  },
  {
    name: 'DeepSeek Coder 6.7B',
    ollama: 'deepseek-coder:6.7b',
    size: '6.7B',
    quantization: 'Q4_K_M',
    ram: '8GB+',
    diskSpace: '4GB',
    description: 'Strong coding performance, good at following instructions',
    useCase: 'Code generation, debugging',
  },
  {
    name: 'Qwen 2.5 Coder 32B',
    ollama: 'qwen2.5-coder:32b',
    size: '32B',
    quantization: 'Q4_K_M',
    ram: '32GB+',
    diskSpace: '18GB',
    description: 'High-end option for complex projects',
    useCase: 'Large codebases, complex reasoning',
  },
];

/**
 * Print curated list of recommended local models
 */
export function printRecommendedLocalModels(): void {
  console.log('\n' + '='.repeat(70));
  console.log('⭐ Recommended Local Models for Claude Code');
  console.log('='.repeat(70));

  console.log('\nThese models have been tested and work well with Claude Code:\n');

  for (const model of RECOMMENDED_LOCAL_MODELS) {
    console.log(`📦 ${model.name}`);
    console.log(`   Ollama: ${model.ollama}`);
    console.log(`   Size: ${model.size} (${model.quantization}) | RAM: ${model.ram} | Disk: ${model.diskSpace}`);
    console.log(`   ${model.description}`);
    console.log(`   Best for: ${model.useCase}`);
    console.log('');
  }

  console.log('📖 Quick Start:');
  console.log('   1. Install Ollama: https://ollama.com');
  console.log('   2. Pull a model: ollama pull qwen2.5-coder:7b');
  console.log('   3. Run Claudish: claudish --model ollama/qwen2.5-coder:7b "task"');

  console.log('\n💡 Pro Tips:');
  console.log('   - Start with qwen2.5-coder:7b (best quality/performance)');
  console.log('   - Use --lite mode for 8K-16K context windows');
  console.log('   - Set CLAUDISH_SHOW_METRICS=1 to see tokens/sec performance');
  console.log('   - Check hardware fit: claudish --check-system');

  console.log('\n📚 Learn More:');
  console.log('   - Model guide: docs/models/local-models.md');
  console.log('   - Quantization explained: docs/models/local-models.md#quantization');

  console.log('\n' + '='.repeat(70) + '\n');
}

/**
 * Print recommended models for detected system
 */
export async function printRecommendedModels(): Promise<void> {
  const resources = await detectSystemResources();

  console.log('\n' + '='.repeat(70));
  console.log('🎯 Recommended Models for Your System');
  console.log('='.repeat(70));

  console.log('\n📊 Your Hardware:');
  console.log(`   ${resources.availableRAM.toFixed(1)}GB RAM available, ${resources.cpuCores} CPU cores${resources.hasGPU ? ', GPU detected' : ''}`);

  console.log('\n✅ Recommended Model Sizes:');
  const recommendation = recommendModelSize(resources);
  console.log(`   ${recommendation}`);

  // Filter recommended models based on available RAM
  const suitableModels = RECOMMENDED_LOCAL_MODELS.filter(model => {
    const ramRequired = parseInt(model.ram);
    return resources.availableRAM >= ramRequired;
  });

  if (suitableModels.length > 0) {
    console.log('\n🌟 Best Models for Your Hardware:');
    for (const model of suitableModels.slice(0, 3)) { // Show top 3 matches
      console.log(`   ${model.name} (${model.ollama})`);
      console.log(`      ${model.description}`);
    }
  }

  console.log('\n💡 Tips:');
  console.log('   - Q4_K_M quantization offers the best quality/size ratio');
  console.log('   - Use --lite mode for models with 8K-16K context windows');
  console.log('   - Set CLAUDISH_CONTEXT_WINDOW if the model reports incorrect size');
  if (resources.hasGPU) {
    console.log('   - GPU detected: Consider Q5_K_M or Q8_0 quantization for better quality');
  } else {
    console.log('   - CPU-only: Stick to Q4_K_M for best performance');
  }

  console.log('\n📖 Usage:');
  console.log('   claudish --model ollama/qwen2.5-coder:7b "task"');
  console.log('   claudish --lite --model ollama/qwen2.5-coder:7b "task"  # Low-resource mode');
  console.log('   claudish --local-models  # See curated list of local models');

  console.log('\n' + '='.repeat(70) + '\n');
}
