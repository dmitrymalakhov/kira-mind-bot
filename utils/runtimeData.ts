import * as path from "path";

/**
 * Небольшие файловые состояния конкретного инстанса. В Docker путь задаётся
 * явно, чтобы не зависеть от того, запускается код из dist/ или из корня.
 */
export const RUNTIME_DATA_DIR =
  process.env.KIRA_RUNTIME_DATA_DIR?.trim() || path.join(__dirname, "..", "data");
