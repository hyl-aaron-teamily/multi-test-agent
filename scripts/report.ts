// Generate ./allure-report from ./allure-results using allure-commandline (Allure 2, needs Java).
// ref: node_modules/allure-vitest/README.md ("allure generate ./allure-results -o ./allure-report");
//      the expected vitest-pnpm-ts example is absent from ref/.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const RESULTS_DIR = './allure-results';
const REPORT_DIR = './allure-report';

if (!existsSync(RESULTS_DIR)) {
  console.error(`No ${RESULTS_DIR} found. Run \`pnpm test\` first.`);
  process.exit(1);
}

const javaCheck = spawnSync('java', ['-version'], { stdio: 'ignore', shell: true });
if (javaCheck.status !== 0) {
  console.error(
    'Java not found. allure-commandline requires a Java runtime (JDK/JRE 8+). ' +
      'Install one (e.g. Temurin 17) and make sure `java` is on PATH or JAVA_HOME is set.',
  );
  process.exit(1);
}

const result = spawnSync('allure', ['generate', RESULTS_DIR, '-o', REPORT_DIR, '--clean'], {
  stdio: 'inherit',
  shell: true,
});
if (result.status === 0) {
  console.log(`Report ready: ${REPORT_DIR}  →  pnpm exec allure open ${REPORT_DIR}`);
}
process.exit(result.status ?? 1);
