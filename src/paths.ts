import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The per-user config directory, matching Go's os.UserConfigDir() so an
 * existing audit.jsonl written by the Go build keeps being appended to in
 * place rather than reappearing somewhere new.
 */
export function userConfigDir(): string {
  switch (process.platform) {
    case "darwin": {
      const home = homedir();
      if (!home) throw new Error("neither $HOME nor a home directory is defined");
      return join(home, "Library", "Application Support");
    }
    case "win32": {
      const appData = process.env.AppData;
      if (!appData) throw new Error("%AppData% is not defined");
      return appData;
    }
    default: {
      const xdg = process.env.XDG_CONFIG_HOME;
      if (xdg) return xdg;
      const home = homedir();
      if (!home) {
        throw new Error("neither $XDG_CONFIG_HOME nor $HOME are defined");
      }
      return join(home, ".config");
    }
  }
}

/** The directory db-mcp keeps its own state in. */
export function appConfigDir(): string {
  return join(userConfigDir(), "db-mcp");
}
