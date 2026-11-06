// T-014 续：自建加密文件后端 —— macOS 上的生产落点。
//
// ## 为什么不是 OS 钥匙串
//
// db 仓原先用 `keyring` crate 存数据库密码（macOS 钥匙串，service=`z-biz-tool-db`）。
// 但 macOS 钥匙串的解密授权段（`kSecACLAuthorizationDecrypt`）把**创建者二进制的
// 代码签名**记为唯一可信应用 —— 而本家族是 adhoc 签名：
//
// ```text
// $ codesign -dv z-biz-tool-file.app
//   Signature=adhoc
// $ codesign -d -r- z-biz-tool-file.app
//   designated => cdhash H"95b7a79091111c9cb0ca3fd36c3c64ea6e6d9b96"
// ```
//
// designated requirement 就是 cdhash ⇒ **每次重新打包 cdhash 就变** ⇒
// 钥匙串认不出新签名 ⇒ 每次读密码都弹「z-biz-tool-file 想要访问你的密钥」。
//
// 数据库密码比 LLM 密钥读得更频繁（每次建连接都要 unseal），弹窗更烦人。
// 所以 macOS 上改用自建加密文件：
//
// ```text
// 密文：~/.z-biz-tool/db/secrets.enc   （JSON 外壳，每条值是 enc:v1: 密文）
// 主密钥：~/.z-biz-tool/db/master.key （0600）
// ```
//
// 算法是 AES-256-GCM，与 cap-llm-config 的 LLM 密钥**同一套原语**
// （`MultiSecretFile`）—— 同机同格式，备份/迁移只需认一种密文。
//
// ## 与旧 keychain 条目的关系
//
// 老 db 仓可能在钥匙串里留了 `z-biz-tool-db` 条目。本后端**不读**它们 ——
// 读一次就弹一次授权，用户体验比「重新输一次密码」更糟。
// 用户首次在新版里保存连接时会写入加密文件，密码也就有了新副本。
// 旧条目由用户在钥匙串里自行清理（`security delete-generic-password -s z-biz-tool-db`）。
//
// ## Windows / Linux
//
// 仍走 OS 凭据管理器 / Secret Service（见 `keychain.rs`）——
// 那两边没有「签名绑定」问题，没必要自建。

use std::path::PathBuf;
use std::sync::Arc;

use cap_llm_config::encrypted_file::MultiSecretFile;

use super::{InMemorySecretStore, PlainSecret, SecretRef, SecretStore};

/// 本后端的 backend 名（写进 SecretRef.backend）。
///
/// **不是** `keychain-macos` —— 与老引用区分开，避免 unseal 拿旧引用来读。
pub const ENCFILE_BACKEND: &str = "encfile";

/// 密文文件在家族目录下的子路径。
pub const DB_SUBDIR: &str = "db";

/// 密文文件名。
pub const SECRETS_FILE: &str = cap_llm_config::MULTI_SECRET_FILE;

/// 基于自建加密文件的 SecretStore 实现。
pub struct EncFileSecretStore {
    file: MultiSecretFile,
}

impl EncFileSecretStore {
    /// 用指定密文文件路径建后端。
    pub fn new(path: PathBuf) -> Self {
        Self {
            file: MultiSecretFile::new(path),
        }
    }

    /// 生产后端：家族目录下的 `db/secrets.enc`。
    pub fn production() -> Self {
        let dir = family_db_dir();
        Self::new(dir.join(SECRETS_FILE))
    }

    /// 探测后端是否可用：目录可建、主密钥可读可写。
    ///
    /// **不碰任何真实条目** —— 只确保「能写」这件事成立。
    pub fn check_available(&self) -> Result<(), String> {
        if let Some(parent) = self.file.path().parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建数据库配置目录失败（{}）: {}", parent.display(), e))?;
        }
        // 读一次全部条目：文件不存在就是空表（不是错误）。
        self.file.read_all().map(|_| ())
    }
}

/// 家族目录下的 `db/` 子目录。
///
/// 优先用 `~/.z-biz-tool/db`（家族统一目录），拿不到就退回
/// `app_config_dir()/db` —— 后者在 Tauri 环境下是
/// `~/Library/Application Support/<bundle-id>/db`。
fn family_db_dir() -> PathBuf {
    if let Some(home) = dirs::home_dir() {
        let dir = home.join(cap_llm_config::FAMILY_DIR).join(DB_SUBDIR);
        if std::fs::create_dir_all(&dir).is_ok() {
            return dir;
        }
    }
    let fallback = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("z-biz-tool-file")
        .join(DB_SUBDIR);
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

impl SecretStore for EncFileSecretStore {
    fn put(&self, label: &str, secret: &PlainSecret) -> Result<SecretRef, String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.file
            .put(&id, &secret.as_str())
            .map_err(|e| format!("写入加密文件失败（连接 {}）: {}", label, e))?;
        Ok(SecretRef {
            backend: ENCFILE_BACKEND.to_string(),
            id,
            label: label.to_string(),
            revision: 0,
        })
    }

    fn get(&self, secret_ref: &SecretRef) -> Result<PlainSecret, String> {
        // 与 InMemorySecretStore / KeychainSecretStore 一致：不跨后端取。
        // 老版本（backend=="inmemory" 或 "keychain-macos"）引用会走到这里
        // 并**显式报错**，由 unseal 标成 missing，不静默失败。
        if secret_ref.backend != ENCFILE_BACKEND {
            return Err(format!(
                "加密文件后端不支持其它后端的引用: {}",
                secret_ref.backend
            ));
        }
        match self.file.get(&secret_ref.id) {
            Ok(Some(v)) => Ok(PlainSecret::new(v)),
            Ok(None) => Err(format!("加密文件里找不到条目（id={}）", secret_ref.id)),
            Err(e) => Err(format!("读取加密文件失败: {}", e)),
        }
    }

    fn delete(&self, secret_ref: &SecretRef) -> Result<(), String> {
        // 幂等且容忍历史引用：seal 在换后端时会拿着旧引用来 delete，
        // 这里必须放行（本后端没有这条 = 删成功）。
        if secret_ref.backend != ENCFILE_BACKEND {
            return Ok(());
        }
        self.file
            .remove(&secret_ref.id)
            .map_err(|e| format!("删除加密文件条目失败: {}", e))
    }

    fn persistent(&self) -> bool {
        true
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn backend_name(&self) -> &str {
        ENCFILE_BACKEND
    }
}

/// 读 env，装配后端（纯函数：env 值作参数，便于测试，不碰全局状态）。
///
/// - `inmemory`：强制内存后端（CI / 无持久化环境用）；
/// - `keychain`：强制 OS 钥匙串（仅 Windows / Linux 有意义；
///   macOS 上明确拒绝并回退 —— 留着它是因为老配置里可能写过这个值）；
/// - `encfile`：强制自建加密文件；
/// - `auto` / 空 / 无法识别的值：走自建加密文件（各平台都可用，且不弹窗）。
pub fn select_backend_from(env_value: Option<&str>) -> Arc<dyn SecretStore> {
    let normalized = env_value.map(|v| v.trim().to_ascii_lowercase());
    match normalized.as_deref() {
        Some("inmemory") => {
            eprintln!(
                "[warn] {}=inmemory：密码仅进程内有效，进程重启后需重新输入",
                super::ENV_SECRET_BACKEND
            );
            Arc::new(InMemorySecretStore::default())
        }
        Some("keychain") => {
            if cfg!(target_os = "macos") {
                // macOS 上钥匙串 = 每次读都弹授权框。明确拒绝并说明，
                // 不静默回退（用户写这个值就是想用钥匙串，得让他知道为什么不行）。
                eprintln!(
                    "[warn] {}=keychain 在 macOS 上不可用：钥匙串授权绑代码签名，\
                     本应用是 adhoc 签名（cdhash 每次重打包都变）⇒ 每次读密码都弹授权框。\
                     已改用自建加密文件（~/.z-biz-tool/db/secrets.enc）。",
                    super::ENV_SECRET_BACKEND
                );
                Arc::new(InMemorySecretStore::default())
            } else {
                match crate::db_app::secrets::keychain::try_keychain_available() {
                    Ok(store) => Arc::new(store),
                    Err(e) => {
                        eprintln!(
                            "[warn] {}=keychain 但 keychain 不可用（{}），已回退 inmemory：\
                             密码将不跨进程持久",
                            super::ENV_SECRET_BACKEND,
                            e
                        );
                        Arc::new(InMemorySecretStore::default())
                    }
                }
            }
        }
        Some("encfile") => {
            let store = EncFileSecretStore::production();
            match store.check_available() {
                Ok(()) => Arc::new(store),
                Err(e) => {
                    eprintln!(
                        "[warn] 加密文件后端不可用（{}），已回退 inmemory：密码仅进程内有效",
                        e
                    );
                    Arc::new(InMemorySecretStore::default())
                }
            }
        }
        None | Some("") | Some("auto") => {
            let store = EncFileSecretStore::production();
            match store.check_available() {
                Ok(()) => Arc::new(store),
                Err(e) => {
                    eprintln!(
                        "[warn] 加密文件后端不可用（{}），回退 inmemory：密码仅进程内有效",
                        e
                    );
                    Arc::new(InMemorySecretStore::default())
                }
            }
        }
        other => {
            eprintln!(
                "[warn] {} 取值无法识别（{:?}），按 auto 处理",
                super::ENV_SECRET_BACKEND,
                other.unwrap_or_default()
            );
            select_backend_from(Some("auto"))
        }
    }
}

/// 按进程 env 装配后端（`secret_store()` 的默认装配入口）。
pub fn select_backend() -> Arc<dyn SecretStore> {
    select_backend_from(std::env::var(super::ENV_SECRET_BACKEND).ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db_app::db::credentials::{seal, unseal, CREDENTIAL_MISSING};
    use crate::db_app::ConnectionRecord;

    /// 临时目录做隔离，避免测出真用户的密文文件。
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let mut p = std::env::temp_dir();
            p.push(format!(
                "zbiz-encfile-test-{}-{}",
                tag,
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&p).expect("建临时目录");
            Self(p)
        }

        fn path(&self) -> PathBuf {
            self.0.join("secrets.enc")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn rec(id: &str, name: &str, password: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: id.to_string(),
            name: name.to_string(),
            db_type: "mysql".to_string(),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: password.to_string(),
            database: "app".to_string(),
            revision: 1,
            environment: "dev".to_string(),
            tls_mode: None,
            tls_ca_path: None,
            secret_ref: None,
            credential_state: String::new(),
            credential_note: None,
        }
    }

    /// put / get / delete 直走后端的 roundtrip。
    #[test]
    fn put_get_delete_roundtrip() {
        let tmp = TempDir::new("roundtrip");
        let store = EncFileSecretStore::new(tmp.path());
        let plain = PlainSecret::new("p@ss-w0rd-123");
        let r = store.put("测试连接", &plain).expect("put");
        assert_eq!(r.backend, ENCFILE_BACKEND);

        let got = store.get(&r).expect("get");
        assert_eq!(got.as_str(), "p@ss-w0rd-123");

        store.delete(&r).expect("delete");
        assert!(store.get(&r).is_err(), "删除后应取不到");
    }

    /// 跨实例 roundtrip：换一个**全新实例**读，证明数据来自文件而不是进程内缓存。
    #[test]
    fn seal_unseal_roundtrip_across_instances() {
        let tmp = TempDir::new("seal");
        let store = EncFileSecretStore::new(tmp.path());
        let incoming = vec![rec("enc-1", "加密连接", "roundtrip-p@ss")];
        let sealed = seal(&store, &incoming, &[]).expect("seal");
        assert_eq!(
            sealed[0].secret_ref.as_ref().map(|r| r.backend.clone()),
            Some(ENCFILE_BACKEND.to_string())
        );

        let fresh = EncFileSecretStore::new(tmp.path());
        let (unsealed, missing) = unseal(&fresh, sealed.clone());
        assert!(missing.is_empty(), "凭据必须能取回: {:?}", missing);
        assert_eq!(unsealed[0].password, "roundtrip-p@ss");
        assert_eq!(unsealed[0].credential_state, "ok");

        if let Some(r) = sealed[0].secret_ref.as_ref() {
            store.delete(r).expect("清理");
        }
        let (_, missing_after) = unseal(&fresh, sealed);
        assert_eq!(
            missing_after.len(),
            1,
            "删除后必须取不到，否则说明有进程内缓存"
        );
    }

    /// 密文文件里**不能出现明文**。
    #[test]
    fn ciphertext_file_does_not_contain_plaintext() {
        let tmp = TempDir::new("cipher");
        let store = EncFileSecretStore::new(tmp.path());
        let plain = PlainSecret::new("plaintext-canary-9876");
        store.put("明文检查", &plain).expect("put");

        let raw = std::fs::read_to_string(tmp.path()).expect("读密文文件");
        assert!(
            !raw.contains("plaintext-canary-9876"),
            "密文文件里绝不能出现明文密码"
        );
        assert!(
            raw.contains(cap_llm_config::encrypted_file::ENC_PREFIX),
            "密文应带 enc:v1: 前缀"
        );
    }

    /// 主密钥文件必须是 0600。
    #[cfg(unix)]
    #[test]
    fn master_key_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("perm");
        let store = EncFileSecretStore::new(tmp.path());
        store.put("权限检查", &PlainSecret::new("x")).expect("put");

        let key_path = tmp.path().parent().unwrap().join("master.key");
        let meta = std::fs::metadata(&key_path).expect("主密钥文件");
        assert_eq!(
            meta.permissions().mode() & 0o777,
            0o600,
            "主密钥权限必须是 0600"
        );
    }

    /// 旧版 keychain-macos 引用：必须显式报 missing，且 delete 幂等放行。
    #[test]
    fn legacy_keychain_ref_marked_missing_and_delete_tolerated() {
        let tmp = TempDir::new("legacy");
        let store = EncFileSecretStore::new(tmp.path());
        let legacy = SecretRef {
            backend: "keychain-macos".to_string(),
            id: "old-uuid".to_string(),
            label: "旧连接".to_string(),
            revision: 0,
        };
        let mut r = rec("legacy-1", "旧连接", "");
        r.secret_ref = Some(legacy.clone());

        let (unsealed, missing) = unseal(&store, vec![r]);
        assert_eq!(unsealed[0].credential_state, CREDENTIAL_MISSING);
        assert_eq!(missing.len(), 1);
        assert!(
            missing[0].reason.contains("请重新输入密码"),
            "旧后端引用必须提示重新输入: {}",
            missing[0].reason
        );
        store.delete(&legacy).expect("删除历史后端引用必须幂等成功");
    }

    /// PlainSecret 取回后 drop 仍然清零（用观察句柄证伪）。
    #[test]
    fn secret_zeroed_on_drop() {
        let tmp = TempDir::new("zero");
        let store = EncFileSecretStore::new(tmp.path());
        let plain = PlainSecret::new("zero-me-please");
        let r = store.put("清零用例", &plain).expect("put");
        let got = store.get(&r).expect("get");
        let observer = Arc::clone(&got.bytes);
        assert!(!got.is_zeroed());
        drop(got);
        let guard = observer.lock().expect("observer lock");
        assert!(
            guard.iter().all(|&b| b == 0),
            "drop 后明文必须被清零，实际残留: {:?}",
            guard
        );
        store.delete(&r).expect("清理");
    }

    /// 后端选择：auto / encfile 必须选到持久后端。
    #[test]
    fn select_backend_prefers_persistent() {
        for env in [None, Some("auto"), Some("encfile")] {
            let store = select_backend_from(env);
            assert!(store.persistent(), "env={:?} 应选持久后端", env);
        }
        assert!(
            !select_backend_from(Some("inmemory")).persistent(),
            "显式 inmemory 必须给非持久后端"
        );
        assert!(
            !select_backend_from(Some(" INMEMORY ")).persistent(),
            "大小写与空白应被归一化"
        );
    }

    /// macOS 上 `keychain` 必须**回退**（不选 keychain 后端）——
    /// 留着这个值的老配置不该把用户拖回弹授权框的老路。
    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_env_falls_back_on_macos() {
        let store = select_backend_from(Some("keychain"));
        // 关键判据：不能是 keychain 后端。
        let is_keychain = store
            .as_any()
            .downcast_ref::<crate::db_app::secrets::keychain::KeychainSecretStore>()
            .is_some();
        assert!(!is_keychain, "macOS 上不得选 keychain 后端");
    }
}
