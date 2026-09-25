//! Auth profile management — reads/writes auth-profiles.json.
//!
//! Direct port of mobile-claw/src/agent/auth-store.ts.

use crate::{
    types::{AuthStatusResult, AuthTokenResult},
    NativeAgentError,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuthProfile {
    provider: String,
    #[serde(rename = "type")]
    auth_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    access: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthProfiles {
    version: u32,
    profiles: HashMap<String, AuthProfile>,
    #[serde(default)]
    last_good: HashMap<String, String>,
    #[serde(default)]
    usage_stats: HashMap<String, serde_json::Value>,
}

impl Default for AuthProfiles {
    fn default() -> Self {
        Self {
            version: 1,
            profiles: HashMap::new(),
            last_good: HashMap::new(),
            usage_stats: HashMap::new(),
        }
    }
}

/// Mask a secret for display: first 7 and last 4 *characters*, never bytes.
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() > 11 {
        let head: String = chars[..7].iter().collect();
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("{}***{}", head, tail)
    } else {
        "***".to_string()
    }
}

fn load_profiles(path: &str) -> AuthProfiles {
    match std::fs::read_to_string(path) {
        Ok(data) => match serde_json::from_str(&data) {
            Ok(profiles) => profiles,
            Err(err) => {
                // Returning a default here means the next save overwrites the
                // file — so a truncated write (disk full, power loss) silently
                // destroyed every stored key with no way back. Keep a copy of
                // the damaged file and shout about it instead.
                tracing::error!(
                    path = %path,
                    error = %err,
                    "auth profile store is corrupt; preserving a .corrupt backup"
                );
                let backup = format!("{}.corrupt.{}", path, chrono::Utc::now().timestamp());
                if let Err(copy_err) = std::fs::copy(path, &backup) {
                    tracing::error!(error = %copy_err, "could not write the corrupt-profile backup");
                }
                AuthProfiles::default()
            }
        },
        Err(_) => AuthProfiles::default(),
    }
}

fn save_profiles(path: &str, profiles: &AuthProfiles) -> Result<(), NativeAgentError> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(profiles)
        .map_err(|e| NativeAgentError::Auth { msg: e.to_string() })?;

    // Write ATOMICALLY: `std::fs::write` truncates the destination first, so a
    // crash, a full disk, or a process kill mid-write left a half-written file
    // — which `load_profiles` then had to treat as corrupt, losing every stored
    // key. Writing to a sibling temp file and renaming means the destination is
    // either the old content or the new one, never a partial mix.
    let tmp = format!("{}.tmp", path);
    std::fs::write(&tmp, &data)?;

    // Restrict to owner-only BEFORE the rename: this file holds API keys and
    // OAuth refresh tokens, and the default mode would leave it readable by
    // every other app/user on the device.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) =
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
        {
            tracing::warn!(path = %tmp, error = %err, "could not restrict auth-store permissions");
        }
    }

    if let Err(err) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(err.into());
    }
    Ok(())
}

fn resolve_key(profiles: &AuthProfiles, provider: &str) -> Option<(String, bool)> {
    // Prefer lastGood profile
    if let Some(last_key) = profiles.last_good.get(provider) {
        if let Some(p) = profiles.profiles.get(last_key) {
            if p.provider == provider {
                if p.auth_type == "oauth" {
                    if let Some(ref access) = p.access {
                        return Some((access.clone(), true));
                    }
                }
                if p.auth_type == "api_key" {
                    if let Some(ref key) = p.key {
                        return Some((key.clone(), false));
                    }
                }
            }
        }
    }
    // Fallback: scan, prefer OAuth
    let mut fallback: Option<String> = None;
    for profile in profiles.profiles.values() {
        if profile.provider != provider {
            continue;
        }
        if profile.auth_type == "oauth" {
            if let Some(ref access) = profile.access {
                return Some((access.clone(), true));
            }
        }
        if profile.auth_type == "api_key" && fallback.is_none() {
            fallback = profile.key.clone();
        }
    }
    fallback.map(|k| (k, false))
}

pub fn get_auth_token(path: &str, provider: &str) -> Result<AuthTokenResult, NativeAgentError> {
    let profiles = load_profiles(path);
    match resolve_key(&profiles, provider) {
        Some((key, is_oauth)) => Ok(AuthTokenResult {
            api_key: Some(key),
            is_oauth,
        }),
        None => Ok(AuthTokenResult {
            api_key: None,
            is_oauth: false,
        }),
    }
}

pub fn set_auth_key(
    path: &str,
    key: &str,
    provider: &str,
    auth_type: &str,
) -> Result<(), NativeAgentError> {
    let mut profiles = load_profiles(path);
    let profile_id = format!("{}-{}", provider, auth_type);
    // `refresh` was hardcoded to None, so an OAuth profile written through
    // setAuthKey could never be refreshed: the moment the access token expired
    // the account was dead and the user had to re-authenticate. Carry over the
    // refresh token (and any extras) from an existing profile for this id.
    let existing = profiles.profiles.get(&profile_id);
    let carried_refresh = existing.and_then(|p| p.refresh.clone());
    let carried_extra = existing.map(|p| p.extra.clone()).unwrap_or_default();
    let profile = AuthProfile {
        provider: provider.to_string(),
        auth_type: auth_type.to_string(),
        key: if auth_type == "api_key" {
            Some(key.to_string())
        } else {
            None
        },
        access: if auth_type == "oauth" {
            Some(key.to_string())
        } else {
            None
        },
        refresh: carried_refresh,
        extra: carried_extra,
    };
    profiles.profiles.insert(profile_id.clone(), profile);
    profiles.last_good.insert(provider.to_string(), profile_id);
    save_profiles(path, &profiles)
}

pub fn delete_auth(path: &str, provider: &str) -> Result<(), NativeAgentError> {
    let mut profiles = load_profiles(path);
    profiles.profiles.retain(|_, p| p.provider != provider);
    profiles.last_good.remove(provider);
    save_profiles(path, &profiles)
}

pub fn get_auth_status(path: &str, provider: &str) -> Result<AuthStatusResult, NativeAgentError> {
    let profiles = load_profiles(path);
    for profile in profiles.profiles.values() {
        if profile.provider != provider {
            continue;
        }
        let key = profile
            .key
            .as_deref()
            .or(profile.access.as_deref())
            .unwrap_or("");
        if !key.is_empty() {
            // Byte slicing (`&key[..7]`) panics when a key contains any
            // multi-byte character — a mis-pasted key was enough to crash the
            // app. Mask by characters instead.
            let masked = mask_key(key);
            return Ok(AuthStatusResult {
                has_key: true,
                masked,
                provider: provider.to_string(),
            });
        }
    }
    Ok(AuthStatusResult {
        has_key: false,
        masked: String::new(),
        provider: provider.to_string(),
    })
}

/// Exchange an OAuth authorization code for tokens.
/// Generic — works with any provider's token endpoint.

/// Persist the tokens from a successful OAuth exchange.
///
/// `exchange_oauth_code` used to hand the raw token JSON back to JS and store
/// nothing, so the refresh token was lost the moment the JS layer forgot it and
/// the session could never be renewed. Called by the handle right after a
/// successful exchange; unknown/absent fields are simply skipped.
pub fn persist_oauth_tokens(
    path: &str,
    provider: &str,
    data: &serde_json::Value,
) -> Result<(), NativeAgentError> {
    let access = data
        .get("access_token")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("accessToken").and_then(|v| v.as_str()));
    let Some(access) = access else {
        return Ok(());
    };
    let refresh = data
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .or_else(|| data.get("refreshToken").and_then(|v| v.as_str()));

    let mut profiles = load_profiles(path);
    let profile_id = format!("{}-oauth", provider);
    let mut extra = profiles
        .profiles
        .get(&profile_id)
        .map(|p| p.extra.clone())
        .unwrap_or_default();
    if let Some(expires_in) = data.get("expires_in").and_then(|v| v.as_i64()) {
        let expires_at = chrono::Utc::now().timestamp_millis() + expires_in * 1000;
        extra.insert("expires_at".to_string(), serde_json::json!(expires_at));
    }

    let existing_refresh = profiles
        .profiles
        .get(&profile_id)
        .and_then(|p| p.refresh.clone());

    profiles.profiles.insert(
        profile_id.clone(),
        AuthProfile {
            provider: provider.to_string(),
            auth_type: "oauth".to_string(),
            key: None,
            access: Some(access.to_string()),
            // A refresh response often omits refresh_token; keep the old one.
            refresh: refresh.map(String::from).or(existing_refresh),
            extra,
        },
    );
    profiles
        .last_good
        .insert(provider.to_string(), profile_id);
    save_profiles(path, &profiles)
}

pub async fn exchange_oauth_code(
    token_url: &str,
    body_json: &str,
    content_type: Option<&str>,
) -> Result<String, NativeAgentError> {
    let client = reqwest::Client::new();
    let ct = content_type.unwrap_or("application/json");

    let request = if ct.contains("x-www-form-urlencoded") {
        let body: HashMap<String, String> =
            serde_json::from_str(body_json).map_err(|e| NativeAgentError::Auth {
                msg: format!("Invalid body JSON: {}", e),
            })?;
        client
            .post(token_url)
            .header("content-type", ct)
            .form(&body)
    } else {
        let body: serde_json::Value =
            serde_json::from_str(body_json).map_err(|e| NativeAgentError::Auth {
                msg: format!("Invalid body JSON: {}", e),
            })?;
        client
            .post(token_url)
            .header("content-type", ct)
            .json(&body)
    };

    let response = request
        .send()
        .await
        .map_err(|e| NativeAgentError::Auth { msg: e.to_string() })?;

    let status = response.status().as_u16();
    let ok = status >= 200 && status < 300;

    let data: serde_json::Value = response
        .json()
        .await
        .unwrap_or_else(|_| serde_json::json!(null));

    let result = if ok {
        serde_json::json!({ "success": true, "status": status, "data": data })
    } else {
        serde_json::json!({
            "success": false,
            "status": status,
            "data": data,
            "text": serde_json::to_string(&data).unwrap_or_default()
        })
    };

    Ok(result.to_string())
}

pub async fn refresh_oauth_token(
    path: &str,
    provider: &str,
) -> Result<AuthTokenResult, NativeAgentError> {
    if provider != "anthropic" {
        return Err(NativeAgentError::Auth {
            msg: format!("OAuth refresh is not supported for provider '{}'", provider),
        });
    }

    let mut profiles = load_profiles(path);
    let profile_id = profiles
        .last_good
        .get(provider)
        .cloned()
        .or_else(|| {
            profiles
                .profiles
                .iter()
                .find(|(_, profile)| profile.provider == provider && profile.auth_type == "oauth")
                .map(|(id, _)| id.clone())
        })
        .ok_or_else(|| NativeAgentError::Auth {
            msg: format!("No OAuth profile found for provider '{}'", provider),
        })?;

    let profile = profiles
        .profiles
        .get_mut(&profile_id)
        .ok_or_else(|| NativeAgentError::Auth {
            msg: format!("Missing auth profile '{}'", profile_id),
        })?;

    let refresh_token = profile
        .refresh
        .clone()
        .ok_or_else(|| NativeAgentError::Auth {
            msg: format!("No refresh token available for provider '{}'", provider),
        })?;

    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ];

    let response = reqwest::Client::new()
        .post("https://console.anthropic.com/v1/oauth/token")
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .form(&params)
        .send()
        .await
        .map_err(|e| NativeAgentError::Auth { msg: e.to_string() })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "Unable to read response body".to_string());
        // Bounded: this body comes from the provider and ends up in an error
        // string that the app may log or show. An HTML error page from a proxy
        // is routinely tens of KB, and a char-safe cut keeps a multi-byte
        // response from panicking the way the old byte slices did.
        let excerpt = crate::llm_driver::safe_excerpt(&body, 500);
        return Err(NativeAgentError::Auth {
            msg: format!("OAuth refresh failed ({}): {}", status, excerpt),
        });
    }

    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|e| NativeAgentError::Auth { msg: e.to_string() })?;

    let access_token = payload
        .get("access_token")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| NativeAgentError::Auth {
            msg: "OAuth refresh response did not include access_token".to_string(),
        })?;

    profile.access = Some(access_token.clone());
    if let Some(new_refresh) = payload.get("refresh_token").and_then(|v| v.as_str()) {
        profile.refresh = Some(new_refresh.to_string());
    }
    profiles.last_good.insert(provider.to_string(), profile_id);
    save_profiles(path, &profiles)?;

    Ok(AuthTokenResult {
        api_key: Some(access_token),
        is_oauth: true,
    })
}

#[cfg(test)]
mod mask_tests {
    use super::*;

    fn tmp_store() -> String {
        std::env::temp_dir()
            .join(format!(
                "nk-auth-{}-{}.json",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn the_auth_store_is_written_owner_only() {
        let path = tmp_store();
        let mut profiles = AuthProfiles::default();
        profiles.profiles.insert(
            "anthropic-api_key".into(),
            AuthProfile {
                provider: "anthropic".into(),
                auth_type: "api_key".into(),
                key: Some("sk-ant-secret".into()),
                access: None,
                refresh: None,
                extra: Default::default(),
            },
        );
        save_profiles(&path, &profiles).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "secrets must not be readable by others");
        }
        // No stray temp file left behind.
        assert!(!std::path::Path::new(&format!("{path}.tmp")).exists());

        let reloaded = load_profiles(&path);
        assert_eq!(
            reloaded.profiles.get("anthropic-api_key").unwrap().key.as_deref(),
            Some("sk-ant-secret")
        );
        std::fs::remove_file(&path).ok();
    }

    /// RFC 6749 §5.1: a refresh response MAY omit `refresh_token`. Dropping the
    /// stored one then would permanently break re-authentication.
    #[test]
    fn a_refresh_without_a_new_refresh_token_keeps_the_old_one() {
        let path = tmp_store();

        persist_oauth_tokens(
            &path,
            "anthropic",
            &serde_json::json!({
                "access_token": "access-1",
                "refresh_token": "refresh-1",
                "expires_in": 3600,
            }),
        )
        .unwrap();

        // Refresh response carries a new access token but NO refresh token.
        persist_oauth_tokens(
            &path,
            "anthropic",
            &serde_json::json!({ "access_token": "access-2", "expires_in": 3600 }),
        )
        .unwrap();

        let p = load_profiles(&path);
        let profile = p.profiles.get("anthropic-oauth").unwrap();
        assert_eq!(profile.access.as_deref(), Some("access-2"), "access updated");
        assert_eq!(
            profile.refresh.as_deref(),
            Some("refresh-1"),
            "the refresh token must survive"
        );
        assert!(profile.extra.contains_key("expires_at"));
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn camel_case_token_fields_are_accepted_too() {
        let path = tmp_store();
        persist_oauth_tokens(
            &path,
            "openai",
            &serde_json::json!({ "accessToken": "a1", "refreshToken": "r1" }),
        )
        .unwrap();
        let p = load_profiles(&path);
        let profile = p.profiles.get("openai-oauth").unwrap();
        assert_eq!(profile.access.as_deref(), Some("a1"));
        assert_eq!(profile.refresh.as_deref(), Some("r1"));
        std::fs::remove_file(&path).ok();
    }

    /// A corrupt store must be preserved, not silently overwritten.
    #[test]
    fn a_corrupt_store_is_backed_up_rather_than_destroyed() {
        let path = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();

        let loaded = load_profiles(&path);
        assert!(loaded.profiles.is_empty(), "falls back to empty");

        let dir = std::path::Path::new(&path).parent().unwrap();
        let stem = std::path::Path::new(&path)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let backup = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                let n = e.file_name().to_string_lossy().into_owned();
                n.starts_with(&stem) && n.contains(".corrupt.")
            });
        assert!(backup, "the damaged file must be copied aside");

        for e in std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()) {
            let n = e.file_name().to_string_lossy().into_owned();
            if n.starts_with(&stem) {
                std::fs::remove_file(e.path()).ok();
            }
        }
    }

    /// BUG-26: the old code sliced BYTES (`&key[..7]`), so any key containing a
    /// multi-byte character panicked instead of returning a masked string.
    #[test]
    fn masking_is_character_based_and_never_panics() {
        let masked = mask_key("sk-ant-api03-abcdefghijklmnop");
        assert!(masked.starts_with("sk-ant-"));
        assert!(masked.ends_with("mnop"));
        assert!(masked.contains("***"));
        // A key with multi-byte characters must not panic.
        for key in ["ключ-секретный-длинный", "密鑰密鑰密鑰密鑰密鑰密鑰", "🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑"] {
            let out = mask_key(key);
            assert!(out.contains("***"), "{key} -> {out}");
        }
    }

    #[test]
    fn short_keys_reveal_nothing() {
        for key in ["", "x", "short", "12345678901"] {
            assert_eq!(mask_key(key), "***", "a short key must not leak any prefix");
        }
        // One character longer than the threshold starts revealing head/tail.
        assert_ne!(mask_key("123456789012"), "***");
    }
}
