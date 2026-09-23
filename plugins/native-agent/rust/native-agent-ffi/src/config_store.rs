use crate::types::InitConfig;
use crate::NativeAgentError;
use std::fs;
use std::path::{Path, PathBuf};

pub fn default_config_path(workspace_path: &str) -> PathBuf {
    let workspace = Path::new(workspace_path);
    let base = workspace.parent().unwrap_or(workspace);
    base.join(".native-agent-config.json")
}

pub fn persist_config(config: &InitConfig, path: &str) -> Result<(), NativeAgentError> {
    let config_path = Path::new(path);
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(config)?;

    // Write ATOMICALLY. `fs::write` truncates first, so a crash, a full disk or
    // the OS killing the app mid-write leaves a half-written file. This config
    // is what `handle_wake` reads to reconstruct the engine in the background
    // (lib.rs), so a truncated file means EVERY background cron job fails from
    // then on — and there is no UI in that path to surface the error or repair
    // it. temp-file + rename makes the destination either the old content or
    // the new one, never a mix.
    let tmp = format!("{}.tmp", path);
    fs::write(&tmp, &json)?;
    if let Err(err) = fs::rename(&tmp, config_path) {
        let _ = fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

pub fn load_persisted_config(path: &str) -> Result<InitConfig, NativeAgentError> {
    let json = fs::read(path)?;
    Ok(serde_json::from_slice(&json)?)
}

#[cfg(test)]
mod tests {
    use super::{default_config_path, load_persisted_config, persist_config};
    use crate::types::InitConfig;

    #[test]
    fn persists_and_loads_config() {
        let root =
            std::env::temp_dir().join(format!("native-agent-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();

        let config = InitConfig {
            db_path: root.join("mobile-claw.db").display().to_string(),
            workspace_path: workspace.display().to_string(),
            auth_profiles_path: root.join("auth-profiles.json").display().to_string(),
        };

        let path = default_config_path(&config.workspace_path);
        persist_config(&config, &path.display().to_string()).unwrap();
        let loaded = load_persisted_config(&path.display().to_string()).unwrap();

        assert_eq!(loaded.db_path, config.db_path);
        assert_eq!(loaded.workspace_path, config.workspace_path);
        assert_eq!(loaded.auth_profiles_path, config.auth_profiles_path);

        let _ = std::fs::remove_dir_all(root);
    }
}
