import semver from 'semver';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const SECURITY = {
  CREDENTIALS_PATH: path.join(os.homedir(), '.config', 'claudish', 'credentials'),
  LOG_DIR_PERMISSIONS: 0o700,
  MIN_HONO_VERSION: '4.10.6',
  LOCALHOST_ONLY: '127.0.0.1',
} as const;

export async function validateDependencies(): Promise<void> {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')
    );

    const honoVersion = packageJson.dependencies?.hono ||
                        packageJson.devDependencies?.hono;

    if (!honoVersion) {
      console.warn('[claudish] ⚠️  Warning: Hono version not detected');
      return;
    }

    const cleanVersion = honoVersion.replace(/[\^~]/, '');

    if (semver.lt(cleanVersion, SECURITY.MIN_HONO_VERSION)) {
      console.error(`[claudish] ❌ SECURITY: Hono ${cleanVersion} has known vulnerabilities`);
      console.error(`[claudish] ❌ Upgrade to ${SECURITY.MIN_HONO_VERSION}+ required`);
      process.exit(1);
    }
  } catch (err) {
    console.warn('[claudish] ⚠️  Could not validate Hono version');
  }
}

export function checkCredentialSecurity(): void {
  // Check if credentials loaded from secure file vs environment
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) return;

  // Check if key exposed in process environment (visible to other users)
  if (process.platform !== 'win32') {
    try {
      const procEnv = fs.readFileSync(`/proc/${process.pid}/environ`, 'utf8');
      if (procEnv.includes('OPENROUTER_API_KEY')) {
        console.warn('[claudish] ⚠️  API key visible in process environment');
        console.warn('[claudish] ⚠️  Consider using secure credential file instead');
      }
    } catch {
      // /proc not available, skip check
    }
  }
}

export function secureLogDirectory(): void {
  const logDir = path.join(process.cwd(), 'logs');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { mode: SECURITY.LOG_DIR_PERMISSIONS });
  } else {
    fs.chmodSync(logDir, SECURITY.LOG_DIR_PERMISSIONS);
  }

  console.log('[claudish] 🔒 Log directory secured (mode 700)');
}
