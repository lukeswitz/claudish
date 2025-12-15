import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { validateDependencies, secureLogDirectory, SECURITY } from "../src/security.js";
import fs from "fs";
import path from "path";

describe("Security", () => {
  test("Hono version meets minimum requirement", async () => {
    // This test will fail if Hono version is below 4.10.6
    await expect(validateDependencies()).resolves.not.toThrow();
  });

  test("Security constants are defined correctly", () => {
    expect(SECURITY.MIN_HONO_VERSION).toBe("4.10.6");
    expect(SECURITY.LOCALHOST_ONLY).toBe("127.0.0.1");
    expect(SECURITY.LOG_DIR_PERMISSIONS).toBe(0o700);
    expect(SECURITY.CREDENTIALS_PATH).toContain(".config/claudish/credentials");
  });

  describe("Log directory permissions", () => {
    const testLogDir = path.join(process.cwd(), "logs");

    afterAll(() => {
      // Cleanup test log directory if it exists
      if (fs.existsSync(testLogDir)) {
        try {
          fs.rmdirSync(testLogDir);
        } catch {
          // Directory not empty or already removed
        }
      }
    });

    test("Log directory has restrictive permissions after securing", () => {
      // Create log directory with secure permissions
      secureLogDirectory();

      // Verify directory exists
      expect(fs.existsSync(testLogDir)).toBe(true);

      // Check permissions (only on Unix-like systems)
      if (process.platform !== "win32") {
        const stats = fs.statSync(testLogDir);
        const permissions = stats.mode & 0o777;
        expect(permissions).toBe(0o700);
      }
    });
  });

  describe("Localhost binding", () => {
    test("SECURITY constant enforces localhost-only binding", () => {
      expect(SECURITY.LOCALHOST_ONLY).toBe("127.0.0.1");
    });
  });
});
