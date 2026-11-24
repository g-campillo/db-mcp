//! Where db-mcp keeps its per-user state.
//!
//! The directory matches Go's os.UserConfigDir(), as the TypeScript build's
//! did, so an audit.jsonl written by an earlier build keeps being appended to
//! in place rather than reappearing somewhere new.

use std::path::PathBuf;

use anyhow::{Result, bail};

/// The operating systems whose per-user config directories differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    MacOs,
    Windows,
    /// Linux and the other Unix-likes, which follow the XDG convention.
    Other,
}

const CURRENT_PLATFORM: Platform = if cfg!(target_os = "macos") {
    Platform::MacOs
} else if cfg!(windows) {
    Platform::Windows
} else {
    Platform::Other
};

/// Looks up one environment variable; `None` means unset.
type Env<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The per-user config directory: ~/Library/Application Support on macOS,
/// %AppData% on Windows, and $XDG_CONFIG_HOME or ~/.config elsewhere.
pub fn user_config_dir() -> Result<PathBuf> {
    user_config_dir_for(CURRENT_PLATFORM, &process_env).map(PathBuf::from)
}

/// The directory db-mcp keeps its own state in: `<user_config_dir>/db-mcp`.
pub fn app_config_dir() -> Result<PathBuf> {
    app_config_dir_for(CURRENT_PLATFORM, &process_env).map(PathBuf::from)
}

/// Reads this process's environment. A value that is not valid UTF-8 is
/// decoded lossily rather than treated as unset, because a set-but-odd HOME
/// still names a home directory.
fn process_env(key: &str) -> Option<String> {
    std::env::var_os(key).map(|v| v.to_string_lossy().into_owned())
}

fn user_config_dir_for(platform: Platform, env: Env) -> Result<String> {
    match platform {
        Platform::MacOs => {
            let home = home_dir(env);
            if home.is_empty() {
                bail!("neither $HOME nor a home directory is defined");
            }
            Ok(join(&[&home, "Library", "Application Support"]))
        }
        Platform::Windows => {
            let app_data = env("AppData").unwrap_or_default();
            if app_data.is_empty() {
                bail!("%AppData% is not defined");
            }
            Ok(app_data)
        }
        Platform::Other => {
            // Returned as given, not normalised, exactly as the TypeScript did.
            let xdg = env("XDG_CONFIG_HOME").unwrap_or_default();
            if !xdg.is_empty() {
                return Ok(xdg);
            }
            let home = home_dir(env);
            if home.is_empty() {
                bail!("neither $XDG_CONFIG_HOME nor $HOME are defined");
            }
            Ok(join(&[&home, ".config"]))
        }
    }
}

fn app_config_dir_for(platform: Platform, env: Env) -> Result<String> {
    Ok(join(&[&user_config_dir_for(platform, env)?, "db-mcp"]))
}

/// The home directory as Node's os.homedir() finds it: $HOME whenever it is
/// set, even to the empty string, and the account database only when it is
/// unset. `std::env::home_dir` alone would skip an empty HOME and fall back,
/// where the TypeScript build stops with an error.
fn home_dir(env: Env) -> String {
    match env("HOME") {
        Some(home) => home,
        None => std::env::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Joins path segments the way Node's path.join does: empty segments are
/// skipped and the result is normalised, so a HOME such as `/Users/x//./y/..`
/// yields the same directory, and the same text in messages, as before.
#[cfg(not(windows))]
fn join(parts: &[&str]) -> String {
    let present: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    normalize(&present.join("/"))
}

/// Windows paths are only ever joined with plain names here, which the
/// standard library joins the same way Node does.
#[cfg(windows)]
fn join(parts: &[&str]) -> String {
    parts
        .iter()
        .collect::<PathBuf>()
        .to_string_lossy()
        .into_owned()
}

/// Node's path.posix.normalize: collapses repeated slashes, drops `.`, lets
/// `..` remove the segment before it (or stay, at the front of a relative
/// path), and keeps one trailing slash if there was one. The rules are purely
/// textual, so symbolic links are not followed.
#[cfg(not(windows))]
fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let trailing_slash = path.ends_with('/');

    let mut segments: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.last().is_some_and(|last| *last != "..") {
                    segments.pop();
                } else if !absolute {
                    // A relative path may climb above its starting point.
                    segments.push("..");
                }
            }
            _ => segments.push(segment),
        }
    }

    if segments.is_empty() {
        return match (absolute, trailing_slash) {
            (true, _) => "/",
            (false, true) => "./",
            (false, false) => ".",
        }
        .to_owned();
    }
    let mut out = String::new();
    if absolute {
        out.push('/');
    }
    out.push_str(&segments.join("/"));
    if trailing_slash {
        out.push('/');
    }
    out
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    /// Only the given variables are visible, so the real environment can't
    /// leak in.
    fn env_of(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> + use<> {
        let map: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    fn user_dir(platform: Platform, vars: &[(&str, &str)]) -> Result<String> {
        user_config_dir_for(platform, &env_of(vars))
    }

    fn app_dir(platform: Platform, vars: &[(&str, &str)]) -> Result<String> {
        app_config_dir_for(platform, &env_of(vars))
    }

    #[test]
    fn macos_uses_application_support_under_home() {
        let vars = [("HOME", "/Users/x")];
        assert_eq!(
            user_dir(Platform::MacOs, &vars).unwrap(),
            "/Users/x/Library/Application Support"
        );
        assert_eq!(
            app_dir(Platform::MacOs, &vars).unwrap(),
            "/Users/x/Library/Application Support/db-mcp"
        );
    }

    #[test]
    fn macos_normalises_home_like_path_join() {
        for home in ["/Users/x/", "/Users/x//", "/Users/x/./y/..", "//Users//x"] {
            assert_eq!(
                user_dir(Platform::MacOs, &[("HOME", home)]).unwrap(),
                "/Users/x/Library/Application Support",
                "HOME={home:?}"
            );
        }
    }

    #[test]
    fn macos_rejects_an_empty_home() {
        let err = user_dir(Platform::MacOs, &[("HOME", "")]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "neither $HOME nor a home directory is defined"
        );
    }

    #[test]
    fn macos_falls_back_to_the_account_home_when_home_is_unset() {
        let dir = user_dir(Platform::MacOs, &[]).unwrap();
        assert!(dir.starts_with('/'), "{dir}");
        assert!(dir.ends_with("/Library/Application Support"), "{dir}");
    }

    #[test]
    fn windows_uses_app_data_as_given() {
        let dir = user_dir(
            Platform::Windows,
            &[("AppData", r"C:\Users\x\AppData\Roaming")],
        );
        assert_eq!(dir.unwrap(), r"C:\Users\x\AppData\Roaming");
    }

    #[test]
    fn windows_requires_app_data() {
        for vars in [&[][..], &[("AppData", "")][..]] {
            let err = user_dir(Platform::Windows, vars).unwrap_err();
            assert_eq!(err.to_string(), "%AppData% is not defined");
        }
    }

    #[test]
    fn other_prefers_xdg_config_home_unnormalised() {
        let vars = [("XDG_CONFIG_HOME", "/x//cfg/"), ("HOME", "/home/u")];
        assert_eq!(user_dir(Platform::Other, &vars).unwrap(), "/x//cfg/");
        // The join that adds db-mcp is what normalises it.
        assert_eq!(app_dir(Platform::Other, &vars).unwrap(), "/x/cfg/db-mcp");
    }

    #[test]
    fn other_falls_back_to_dot_config_under_home() {
        let vars = [("XDG_CONFIG_HOME", ""), ("HOME", "/home/u")];
        assert_eq!(user_dir(Platform::Other, &vars).unwrap(), "/home/u/.config");
    }

    #[test]
    fn other_rejects_an_empty_home_without_xdg() {
        let err = user_dir(Platform::Other, &[("HOME", "")]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "neither $XDG_CONFIG_HOME nor $HOME are defined"
        );
    }

    /// Expected values were produced by Node's path.posix.normalize.
    #[test]
    fn normalize_matches_node() {
        let cases = [
            ("", "."),
            ("/", "/"),
            ("//", "/"),
            ("/..", "/"),
            ("/a/../..", "/"),
            ("/../x", "/x"),
            (".", "."),
            ("./", "./"),
            ("a/..", "."),
            ("a/../", "./"),
            ("..", ".."),
            ("../x/..", ".."),
            ("a/../../b", "../b"),
            ("../../a", "../../a"),
            ("a//b/./c/", "a/b/c/"),
            ("/Users/x//./y/../db-mcp", "/Users/x/db-mcp"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize(input), want, "normalize({input:?})");
        }
    }

    #[test]
    fn join_skips_empty_segments() {
        assert_eq!(join(&["", "a", "", "b"]), "a/b");
        assert_eq!(join(&["", ""]), ".");
    }
}
