//! 语雀 OpenAPI v2 客户端。
//!
//! 与 future-brain 的 YuqueApiClient.java 同一套接口面（验证 token / 仓库列表 /
//! TOC 目录 / 文档正文），认证头 `X-Auth-Token`。默认域名是语雀公有云
//! `https://www.yuque.com/api/v2`，私有部署/租户域名走 config 覆盖。
//!
//! 响应统一是 `{ data: ... }` 外壳；错误时 HTTP 非 2xx，401 单独给中文提示。

use serde::{Deserialize, Serialize};
use std::time::Duration;

pub const DEFAULT_API_BASE: &str = "https://www.yuque.com/api/v2";

#[derive(Debug, Clone, Serialize)]
pub struct YuqueRepo {
    /// `login/slug`，后续 toc / docs 接口的命名空间
    pub namespace: String,
    pub name: String,
    /// 归属（个人 / 团队名），前端分组展示用
    pub scope: String,
}

/// TOC 目录树的一个节点。整棵树是平铺数组，前端按 parent_uuid 组装。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YuqueTocItem {
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub parent_uuid: String,
    /// TITLE 目录节点 / DOC 文档 / LINK 外链
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    /// DOC 的 slug（docs/{slug} 接口的入参）
    #[serde(default)]
    pub url: String,
}

pub struct YuqueClient {
    base: String,
    token: String,
    http: reqwest::Client,
}

impl YuqueClient {
    pub fn new(api_base: Option<&str>, token: &str) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| format!("构建 HTTP 客户端失败: {}", e))?;
        Ok(Self {
            base: api_base
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim_end_matches('/').to_string())
                .unwrap_or_else(|| DEFAULT_API_BASE.to_string()),
            token: token.to_string(),
            http,
        })
    }

    async fn get_json(&self, path: &str) -> Result<serde_json::Value, String> {
        let url = format!("{}{}", self.base, path);
        let resp = self
            .http
            .get(&url)
            .header("X-Auth-Token", &self.token)
            .header("User-Agent", "z-biz-tool-file")
            .send()
            .await
            .map_err(|e| format!("请求语雀接口失败（{}）: {}", url, e))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| format!("读取语雀响应失败: {}", e))?;
        if status.as_u16() == 401 {
            return Err("语雀 Token 无效或已过期（HTTP 401），请到设置里重新配置".to_string());
        }
        if !status.is_success() {
            return Err(format!("语雀接口返回 HTTP {}: {}", status, truncate(&body, 200)));
        }
        serde_json::from_str(&body).map_err(|e| format!("语雀响应不是合法 JSON: {}", e))
    }

    fn data<'a>(&self, value: &'a serde_json::Value) -> Result<&'a serde_json::Value, String> {
        value
            .get("data")
            .ok_or_else(|| "语雀响应缺少 data 字段".to_string())
    }

    /// 验证 token，返回 (login, name)。
    pub async fn current_user(&self) -> Result<(String, String), String> {
        let value = self.get_json("/user").await?;
        let data = self.data(&value)?;
        let login = data
            .get("login")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "语雀响应缺少 user.login".to_string())?
            .to_string();
        let name = data
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or(&login)
            .to_string();
        Ok((login, name))
    }

    /// 仓库列表：个人的 + 所在团队的（团队最多取 20 个，防止大账号刷爆接口）。
    pub async fn list_repos(&self) -> Result<Vec<YuqueRepo>, String> {
        let (login, _) = self.current_user().await?;
        let mut repos = Vec::new();

        let personal = self.get_json(&format!("/users/{}/repos", login)).await?;
        if let Some(items) = self.data(&personal)?.as_array() {
            for item in items {
                if let Some(repo) = parse_repo(item, "个人") {
                    repos.push(repo);
                }
            }
        }

        let groups = self.get_json(&format!("/users/{}/groups", login)).await?;
        if let Some(items) = self.data(&groups)?.as_array() {
            for group in items.iter().take(20) {
                let group_login = group.get("login").and_then(|v| v.as_str()).unwrap_or("");
                let group_name = group
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(group_login);
                if group_login.is_empty() {
                    continue;
                }
                let list = self.get_json(&format!("/groups/{}/repos", group_login)).await?;
                if let Ok(data) = self.data(&list) {
                    if let Some(items) = data.as_array() {
                        for item in items {
                            if let Some(repo) = parse_repo(item, group_name) {
                                repos.push(repo);
                            }
                        }
                    }
                }
            }
        }

        repos.retain(|r| !r.namespace.is_empty());
        Ok(repos)
    }

    /// 知识库的 TOC 目录（平铺数组，前端组树）。
    pub async fn toc(&self, namespace: &str) -> Result<Vec<YuqueTocItem>, String> {
        let value = self.get_json(&format!("/repos/{}/toc", namespace)).await?;
        let data = self.data(&value)?;
        let arr = data
            .as_array()
            .ok_or_else(|| "语雀 TOC 响应不是数组".to_string())?;
        let mut items = Vec::with_capacity(arr.len());
        for item in arr {
            items.push(YuqueTocItem {
                uuid: item
                    .get("uuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                parent_uuid: item
                    .get("parent_uuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                kind: item
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("TITLE")
                    .to_string(),
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
                url: item
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string(),
            });
        }
        Ok(items)
    }

    /// 拉一篇文档，返回 (title, body)。body 是 markdown 形态正文。
    pub async fn doc(&self, namespace: &str, slug: &str) -> Result<(String, String), String> {
        let value = self
            .get_json(&format!("/repos/{}/docs/{}", namespace, slug))
            .await?;
        let data = self.data(&value)?;
        let title = data
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or(slug)
            .to_string();
        let body = data
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        Ok((title, body))
    }
}

fn parse_repo(item: &serde_json::Value, scope: &str) -> Option<YuqueRepo> {
    let namespace = item
        .get("namespace")
        .and_then(|v| v.as_str())?
        .to_string();
    let name = item
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&namespace)
        .to_string();
    Some(YuqueRepo {
        namespace,
        name,
        scope: scope.to_string(),
    })
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect()
    }
}
