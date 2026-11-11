import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';

// On the Debian box (and its CI runner) Playwright uses the system Chrome.
const systemChrome = '/opt/google/chrome/chrome';
// No LCD text: on some machines its colour fringes read as blue ink in the pixel checks.
const launchOptions = {
	args: ['--disable-lcd-text'],
	...(existsSync(systemChrome) ? { executablePath: systemChrome } : {})
};
// E2E_PORT lets parallel worktrees on one machine run their own server.
const port = Number(process.env.E2E_PORT ?? 4317);

export default defineConfig({
	testDir: 'tests/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	workers: process.env.CI ? 2 : undefined,
	reporter: process.env.CI ? [['list'], ['github']] : 'list',
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: 'off',
		launchOptions
	},
	projects: [
		{
			name: 'desktop-chrome',
			use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions }
		},
		{
			name: 'phone',
			use: { ...devices['Pixel 7'], launchOptions }
		}
	],
	webServer: {
		// The real build, served with its real _headers (CSP included).
		// CI builds in an earlier step and sets E2E_SKIP_BUILD.
		// VITE_DEV_HARNESS=1 adds the /dev-editor test harness; production builds leave it out.
		command: `${process.env.E2E_SKIP_BUILD ? '' : 'VITE_DEV_HARNESS=1 npm run build && '}node scripts/serve-build.mjs ${port}`,
		url: `http://127.0.0.1:${port}/`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: 'ignore',
		stderr: 'pipe'
	}
});
