import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Only absolute XDG state directories are valid. Keeping this path calculation
// shared between creation and observable cleanup validation prevents a drift
// that could either leak a private home or reject a legitimate one.
export function codexHomeRoot(): string {
  const xdg = process.env.XDG_STATE_HOME;
  const stateHome = xdg !== undefined && xdg !== "" && isAbsolute(xdg)
    ? xdg
    : join(homedir(), ".local", "state");
  return join(stateHome, "wux-review", "codex-homes");
}
