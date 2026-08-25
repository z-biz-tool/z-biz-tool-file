use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::io::Read;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 简化的 SSH 连接参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConn {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 密码或私钥路径（简化：先只支持密码 + 私钥路径二选一）
    pub auth: SshAuth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SshAuth {
    #[serde(rename = "password")]
    Password { password: String },
    #[serde(rename = "key")]
    Key {
        /// 私钥文件路径（~/.ssh/id_rsa 等）
        key_path: String,
        /// 私钥密码（如果私钥本身有密码）
        key_passphrase: Option<String>,
    },
}

/// 远端文件条目（和本地 FileEntry 字段一致，path 是 sftp 绝对路径）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpFileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// 修改时间戳（unix seconds）
    pub modified: i64,
}

/// SSH 连接 + 鉴权（带超时）
fn connect(conn: &SshConn, timeout_secs: u64) -> Result<Session, String> {
    let addr = format!("{}:{}", conn.host, conn.port);
    let tcp = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("地址无效: {}", e))?,
        std::time::Duration::from_secs(timeout_secs),
    )
    .map_err(|e| format!("TCP 连接失败: {}", e))?;
    tcp.set_read_timeout(Some(std::time::Duration::from_secs(timeout_secs)))
        .ok();
    tcp.set_write_timeout(Some(std::time::Duration::from_secs(timeout_secs)))
        .ok();
    let mut sess = Session::new().map_err(|e| format!("SSH session 创建失败: {}", e))?;
    sess.set_tcp_stream(tcp);
    sess.handshake().map_err(|e| format!("SSH 握手失败: {}", e))?;
    match &conn.auth {
        SshAuth::Password { password } => {
            sess.userauth_password(&conn.user, password)
                .map_err(|e| format!("密码登录失败: {}", e))?;
        }
        SshAuth::Key {
            key_path,
            key_passphrase,
        } => {
            // ssh2 0.9+ 移除了 PrivateKey 直接构造，userauth_pubkey_file 接受路径
            let key_path = PathBuf::from(key_path);
            if !key_path.exists() {
                return Err(format!("私钥文件不存在: {}", key_path.display()));
            }
            let passphrase = key_passphrase.as_deref();
            sess.userauth_pubkey_file(&conn.user, None, &key_path, passphrase)
                .map_err(|e| format!("公钥登录失败: {}", e))?;
        }
    }
    if !sess.authenticated() {
        return Err("SSH 鉴权失败（authenticated=false）".to_string());
    }
    Ok(sess)
}

/// 测试连接（不列目录）
#[tauri::command]
pub async fn ssh_test_connection(
    conn: SshConn,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let timeout = timeout_secs.unwrap_or(15);
    let start = Instant::now();
    let conn_clone = conn.clone();
    let result = tokio::task::spawn_blocking(move || {
        let _sess = connect(&conn_clone, timeout)?;
        Ok::<String, String>(format!("ok"))
    })
    .await
    .map_err(|e| format!("join 失败: {}", e))?;
    let ms = start.elapsed().as_millis();
    match result {
        Ok(_) => Ok(format!("连接成功，耗时 {}ms", ms)),
        Err(e) => Err(e),
    }
}

/// 列出远端目录
#[tauri::command]
pub async fn ssh_list_dir(
    conn: SshConn,
    path: String,
    timeout_secs: Option<u64>,
) -> Result<Vec<SftpFileEntry>, String> {
    let timeout = timeout_secs.unwrap_or(15);
    let conn_clone = conn.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Vec<SftpFileEntry>, String> {
        let sess = connect(&conn_clone, timeout)?;
        let sftp = sess.sftp().map_err(|e| format!("SFTP 初始化失败: {}", e))?;
        let entries = sftp
            .readdir(Path::new(&path))
            .map_err(|e| format!("读目录失败 ({}): {}", path, e))?;
        let mut out = Vec::new();
        for (path_buf, stat) in entries {
            let name = path_buf
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            // 跳过 . 和 ..
            if name == "." || name == ".." {
                continue;
            }
            let is_dir = stat.is_dir();
            let size = stat.size.unwrap_or(0);
            let modified = stat.mtime.unwrap_or(0) as i64;
            out.push(SftpFileEntry {
                name,
                path: path_buf.to_string_lossy().to_string(),
                is_dir,
                size,
                modified,
            });
        }
        // 排序：目录在前，然后按字母
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    })
    .await
    .map_err(|e| format!("join 失败: {}", e))??;
    Ok(result)
}

/// 读取远端文件内容
#[tauri::command]
pub async fn ssh_read_file(
    conn: SshConn,
    path: String,
    timeout_secs: Option<u64>,
) -> Result<ReadFileResult, String> {
    let timeout = timeout_secs.unwrap_or(30);
    let conn_clone = conn.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<ReadFileResult, String> {
        let sess = connect(&conn_clone, timeout)?;
        let sftp = sess.sftp().map_err(|e| format!("SFTP 初始化失败: {}", e))?;
        let mut file = sftp
            .open(Path::new(&path))
            .map_err(|e| format!("打开远端文件失败: {}", e))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .map_err(|e| format!("读取远端文件失败: {}", e))?;
        // 检测 binary：尝试 UTF-8 decode
        let content = match String::from_utf8(buf.clone()) {
            Ok(s) => ReadFileResult {
                content: s,
                is_binary: false,
                size: file.stat().map(|s| s.size.unwrap_or(0)).unwrap_or(0),
            },
            Err(_) => ReadFileResult {
                content: String::from_utf8_lossy(&buf).to_string(),
                is_binary: true,
                size: file.stat().map(|s| s.size.unwrap_or(0)).unwrap_or(0),
            },
        };
        Ok(content)
    })
    .await
    .map_err(|e| format!("join 失败: {}", e))??;
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileResult {
    pub content: String,
    pub is_binary: bool,
    pub size: u64,
}
