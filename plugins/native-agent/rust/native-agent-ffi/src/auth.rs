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

fn load_profiles(path: &str) -> AuthProfiles {
    match std::fs::read_to_string(path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => AuthProfiles::default(),
    }
}

fn save_profiles(path: &str, profiles: &AuthProfiles) -> Result<(), NativeAgentError> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_string_pretty(profiles)
        .map_err(|e| NativeAgentError::Auth { msg: e.to_string() })?;
    std::fs::write(path, data)?;
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
        refresh: None,
        extra: HashMap::new(),
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
            let masked = if key.len() > 11 {
                format!("{}***{}", &key[..7], &key[key.len() - 4..])
            } else {
                "***".to_string()
            };
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
        return Err(NativeAgentError::Auth {
            msg: format!("OAuth refresh failed ({}): {}", status, body),
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
